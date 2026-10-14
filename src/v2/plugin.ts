import type { Credential, Plugin } from "@opencode/plugin";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { fileURLToPath } from "node:url";
import { createAntigravityCore, isRemovedModelId } from "../plugin";
import { isOAuthAuth, parseRefreshParts } from "../plugin/auth";
import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { createLogger } from "../plugin/logger";
import { createBrowserOAuthAuthorization, replaceStoredAccount } from "../plugin/oauth-flow";
import { hashRefreshToken, loadAccounts } from "../plugin/storage";
import { refreshAccessToken } from "../plugin/token";
import type {
  AntigravityRoute,
  AuthDetails,
  GoogleSearchArgs,
  OAuthAuthorizationResult,
  ProviderModel,
} from "../plugin/types";
import {
  assertSameAccount,
  buildActionField,
  parseLoginAction,
  resolveReauthIndex,
  summarizeAccounts,
  type PoolAccountSummary,
} from "./actions";
import { createV2GetAuth, createV2RevokedReporter } from "./host";
import { applyV2Model, toV2Model } from "./models";

export const PLUGIN_ID = "opencode-antigravity-auth";
export const OAUTH_METHOD_ID = "antigravity";
const OAUTH_METHOD_LABEL = "OAuth with Google (Antigravity)";
const PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID;

/** Credential events often come in bursts (sign-in, then token storage). */
const CREDENTIAL_EVENT_DEBOUNCE_MS = 300;
const MAX_RESUBSCRIBE_DELAY_MS = 30_000;

const log = createLogger("v2");

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * `aisdk:` package for the `google` provider. OpenCode imports the module
 * behind the file URL for its `create*` export (see ./sdk.ts).
 */
export function sdkPackage(moduleUrl: string = import.meta.url): string {
  const file = moduleUrl.endsWith(".ts") ? "./sdk.ts" : "./sdk.js";
  return `aisdk:${new URL(file, moduleUrl).href}`;
}

/** Command that runs the account manager CLI shipped next to this module. */
export function cliCommand(moduleUrl: string = import.meta.url): string {
  const file = moduleUrl.endsWith(".ts") ? "./cli.ts" : "./cli.js";
  return `bun "${fileURLToPath(new URL(file, moduleUrl)).replace(/\\/g, "/")}"`;
}

async function loadPool(): Promise<PoolAccountSummary[]> {
  try {
    const storage = await loadAccounts();
    return summarizeAccounts((storage?.accounts ?? []).filter((account) => !!account?.refreshToken));
  } catch {
    return [];
  }
}

/**
 * What the loader and the login form depend on: the active credential and
 * the pool's accounts. Tokens are hashed; the key never leaves this process.
 */
function credentialKey(auth: AuthDetails, pool: readonly PoolAccountSummary[]): string {
  let credential: string = auth.type;
  if (isOAuthAuth(auth)) {
    credential = `oauth:${hashRefreshToken(parseRefreshParts(auth.refresh).refreshToken)}`;
  } else if (typeof auth.key === "string") {
    credential = `${auth.type}:${hashRefreshToken(auth.key)}`;
  }
  return JSON.stringify([credential, pool]);
}

function toCredential(result: AntigravityTokenExchangeResult): Credential.OAuth {
  if (result.type !== "success") {
    throw new Error(result.error);
  }
  return {
    type: "oauth",
    methodID: OAUTH_METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    ...(result.email ? { metadata: { email: result.email } } : {}),
  } as Credential.OAuth;
}

/** Converts the core's OAuth authorization into the V2 integration shape. */
export function toV2Authorization(result: OAuthAuthorizationResult) {
  const expiresAt = result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {};
  if (result.method === "auto") {
    return {
      url: result.url,
      instructions: result.instructions,
      ...expiresAt,
      mode: "auto" as const,
      callback: result.callback().then(toCredential),
    };
  }
  return {
    url: result.url,
    instructions: result.instructions,
    ...expiresAt,
    mode: "code" as const,
    callback: (code: string) => result.callback(code).then(toCredential),
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const server: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const getAuth = createV2GetAuth(ctx, PROVIDER_ID);
    const core = await createAntigravityCore({
      directory: ctx.location.directory,
      options: ctx.options,
      getAuth,
      onAccountsRevoked: createV2RevokedReporter(ctx, PROVIDER_ID),
    });
    const packageName = sdkPackage();

    // State captured by the synchronous provider transform; refreshed in the
    // background and applied with ctx.provider.reload().
    let pool = await loadPool();
    let modelDefinitions: Record<string, ProviderModel> = OPENCODE_MODEL_DEFINITIONS;
    let lastCredentialKey = credentialKey(await getAuth().catch(() => ({ type: "none" })), pool);

    // The core's route (account pool + Antigravity fetch). It is built on first
    // use and again after credentials change; SDKs cached by OpenCode keep
    // calling through `antigravityFetch`, which always uses the latest route.
    let route: Promise<AntigravityRoute | undefined> | undefined;
    const load = () => {
      route ??= core.loader().catch((error) => {
        route = undefined;
        throw error;
      });
      return route;
    };
    /** Drops the current route; the replaced one stops its timers and saves. */
    const resetRoute = async () => {
      const previous = route;
      route = undefined;
      const loaded = await previous?.catch(() => undefined);
      await loaded?.dispose();
    };
    const antigravityFetch = (hostFetch: FetchFn): FetchFn => async (input, init) => {
      const loaded = await load();
      if (!loaded) return hostFetch(input, init);
      return loaded.fetch(input instanceof URL ? input.toString() : input, init);
    };

    /** Refreshes model definitions, then reloads the provider (activation may have changed too). */
    const refreshProvider = async () => {
      try {
        const models = await core.models();
        if (Object.keys(models).length > 0) {
          modelDefinitions = models;
        }
      } catch (error) {
        log.debug("model-discovery-failed", { error: error instanceof Error ? error.message : String(error) });
      }
      await ctx.provider.reload();
    };

    await ctx.provider.transform((editor) => {
      const record = editor.get(PROVIDER_ID);
      if (!record) return;
      editor.update(PROVIDER_ID, (provider) => {
        provider.package = packageName;
        // Accounts added through this plugin live on disk, not in OpenCode's
        // credential store, so they must activate the provider themselves.
        if (pool.length > 0) provider.activation = "enabled";
      });
      for (const [id, model] of record.models) {
        if (isRemovedModelId(id)) {
          editor.models.remove(PROVIDER_ID, id);
        } else if (model.package) {
          editor.models.update(PROVIDER_ID, id, (draft) => {
            delete draft.package;
          });
        }
      }
      for (const [id, definition] of Object.entries(modelDefinitions)) {
        if (isRemovedModelId(id)) continue;
        const patch = toV2Model(id, definition);
        editor.models.update(PROVIDER_ID, id, (draft) => applyV2Model(draft, patch));
      }
    });

    await ctx.aisdk.hook(
      "sdk",
      async (event) => {
        if (event.model.providerID !== PROVIDER_ID) return;
        const loaded = await load();
        const hostFetch: FetchFn = typeof event.options.fetch === "function" ? event.options.fetch : fetch;
        event.sdk = createGoogleGenerativeAI({
          ...(typeof event.options.name === "string" ? { name: event.options.name } : {}),
          ...(event.options.headers ? { headers: event.options.headers } : {}),
          ...(typeof event.options.baseURL === "string" ? { baseURL: event.options.baseURL } : {}),
          // Requests routed by the core are authenticated there; the host's key
          // is only used when there is nothing to route with.
          apiKey: loaded ? "" : (event.options.apiKey ?? ""),
          fetch: antigravityFetch(hostFetch),
        });
      },
      { providerID: PROVIDER_ID },
    );

    await ctx.integration.transform((editor) => {
      if (!editor.get(PROVIDER_ID)) return;
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: OAUTH_METHOD_ID,
          type: "oauth",
          label: OAUTH_METHOD_LABEL,
          form: [buildActionField(pool, cliCommand())],
        },
        // Both actions use the non-interactive browser flow. Interactive
        // account management (delete, enable/disable, quotas) lives in the CLI.
        authorize: async (answer) => {
          const action = parseLoginAction(answer, pool);
          if (action.type === "add") {
            return toV2Authorization(await createBrowserOAuthAuthorization());
          }
          return toV2Authorization(
            await createBrowserOAuthAuthorization({
              loginHint: action.email,
              persist: async (result) => {
                const accounts = (await loadAccounts())?.accounts ?? [];
                const index = resolveReauthIndex(accounts, action);
                if (index === undefined) {
                  throw new Error(
                    `${action.email ?? `Account ${action.index + 1}`} is no longer in the account pool. Nothing was changed.`,
                  );
                }
                assertSameAccount(accounts[index]?.email, result.email);
                await replaceStoredAccount(index, result);
                log.info(`Re-authenticated ${result.email ?? `account ${index + 1}`}`);
              },
            }),
          );
        },
        refresh: async (credential) => {
          const refreshed = await refreshAccessToken({
            type: "oauth",
            refresh: credential.refresh,
            access: credential.access,
            expires: credential.expires,
          });
          if (!refreshed?.access) {
            throw new Error("Antigravity token refresh failed");
          }
          return {
            ...credential,
            refresh: refreshed.refresh,
            access: refreshed.access,
            expires: refreshed.expires ?? 0,
          };
        },
        label: (credential) => {
          const email = credential.metadata?.email;
          return typeof email === "string" ? email : undefined;
        },
      });
    });

    const search = core.tool.google_search;
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "google_search",
        description: search.description,
        input: search.input,
        execute: async (input, context) => ({
          content: await search.execute(input as GoogleSearchArgs, context.signal),
        }),
      });
    });

    // credential.updated / credential.switched carry no data and fire for every
    // provider. Rebuild only when the google credential or the pool changed.
    let checking: Promise<void> = Promise.resolve();
    const checkCredentials = () => {
      checking = checking.then(async () => {
        const nextPool = await loadPool();
        const key = credentialKey(await getAuth().catch(() => ({ type: "none" })), nextPool);
        if (key === lastCredentialKey) return;
        lastCredentialKey = key;
        pool = nextPool;
        await resetRoute();
        await ctx.integration.reload();
        await refreshProvider();
      }).catch((error) => {
        log.warn("Failed to apply credential change", { error: error instanceof Error ? error.message : String(error) });
      });
      return checking;
    };
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const scheduleCheck = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        void checkCredentials();
      }, CREDENTIAL_EVENT_DEBOUNCE_MS);
      debounce.unref?.();
    };

    // Keep listening for the plugin's lifetime: a subscription that ends or
    // fails is opened again (with backoff), then checks for missed changes.
    const abort = new AbortController();
    void (async () => {
      let failures = 0;
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            failures = 0;
            const type = (event as { type?: string }).type;
            if (type === "credential.updated" || type === "credential.switched") {
              scheduleCheck();
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log.warn("Event subscription failed; reconnecting", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (abort.signal.aborted) break;
        failures += 1;
        await abortableDelay(Math.min(MAX_RESUBSCRIBE_DELAY_MS, 500 * 2 ** failures), abort.signal);
        if (!abort.signal.aborted) scheduleCheck();
      }
    })();

    void refreshProvider();

    return async () => {
      abort.abort();
      if (debounce) clearTimeout(debounce);
      await resetRoute();
      await core.dispose();
    };
  },
};

export default server;
