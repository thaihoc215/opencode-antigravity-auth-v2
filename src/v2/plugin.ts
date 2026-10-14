import type { Credential, Plugin } from "@opencode/plugin";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { fileURLToPath } from "node:url";
import {
  createAntigravityPlugin,
  createBrowserOAuthAuthorization,
  isRemovedModelId,
  replaceStoredAccount,
} from "../plugin";
import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { createLogger } from "../plugin/logger";
import { loadAccounts } from "../plugin/storage";
import { refreshAccessToken } from "../plugin/token";
import type {
  GoogleSearchArgs,
  LoaderResult,
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
import { createV2Client, createV2GetAuth } from "./host";
import { applyV2Model, toV2Model } from "./models";

export const PLUGIN_ID = "opencode-antigravity-auth";
export const OAUTH_METHOD_ID = "antigravity";
const OAUTH_METHOD_LABEL = "OAuth with Google (Antigravity)";
const PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID;

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

function hasFetch(result: LoaderResult | Record<string, unknown>): result is LoaderResult {
  return typeof (result as Partial<LoaderResult>).fetch === "function";
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
  if (result.method === "auto") {
    return {
      url: result.url,
      instructions: result.instructions,
      mode: "auto" as const,
      callback: result.callback().then(toCredential),
    };
  }
  return {
    url: result.url,
    instructions: result.instructions,
    mode: "code" as const,
    callback: (code: string) => result.callback(code).then(toCredential),
  };
}

const server: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const client = createV2Client(ctx, PROVIDER_ID);
    const getAuth = createV2GetAuth(ctx, PROVIDER_ID);
    const core = await createAntigravityPlugin(PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
      options: ctx.options,
    });
    const packageName = sdkPackage();

    // State captured by the synchronous provider transform; refreshed in the
    // background and applied with ctx.provider.reload().
    let pool = await loadPool();
    let modelDefinitions: Record<string, ProviderModel> = OPENCODE_MODEL_DEFINITIONS;

    // The core loader builds the account pool and the Antigravity fetch. It runs
    // once and again after credentials change; SDKs cached by OpenCode keep
    // calling through `antigravityFetch`, which always uses the latest loader.
    let loader: Promise<LoaderResult | Record<string, unknown>> | undefined;
    const load = () => {
      loader ??= core.auth.loader(getAuth, { id: PROVIDER_ID, models: {} }).catch((error) => {
        loader = undefined;
        throw error;
      });
      return loader;
    };
    const antigravityFetch = (hostFetch: FetchFn): FetchFn => async (input, init) => {
      const loaded = await load();
      if (!hasFetch(loaded)) return hostFetch(input, init);
      return loaded.fetch(input instanceof URL ? input.toString() : input, init);
    };

    const discoverModels = async () => {
      try {
        const models = await core.provider?.models?.({ id: PROVIDER_ID, models: {} }, { auth: await getAuth() });
        if (models && Object.keys(models).length > 0) {
          modelDefinitions = models;
          await ctx.provider.reload();
        }
      } catch (error) {
        log.debug("model-discovery-failed", { error: error instanceof Error ? error.message : String(error) });
      }
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
          // OAuth requests are authenticated by the Antigravity fetch; the key is
          // only used on the plain Gemini API path.
          apiKey: hasFetch(loaded) ? loaded.apiKey : (event.options.apiKey ?? ""),
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
        // Both actions use the core's non-interactive browser flow. Interactive
        // account management (delete, enable/disable, quotas) lives in the CLI.
        authorize: async (answer) => {
          const action = parseLoginAction(answer, pool);
          if (action.type === "add") {
            return toV2Authorization(await createBrowserOAuthAuthorization(client));
          }
          return toV2Authorization(
            await createBrowserOAuthAuthorization(client, {
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
                await client.tui.showToast({
                  body: { message: `Re-authenticated ${result.email ?? `account ${index + 1}`}`, variant: "success" },
                });
              },
            }),
          );
        },
        refresh: async (credential) => {
          const refreshed = await refreshAccessToken(
            { type: "oauth", refresh: credential.refresh, access: credential.access, expires: credential.expires },
            client,
            PROVIDER_ID,
          );
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

    const search = core.tool?.google_search;
    if (search) {
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
    }

    // A sign-in changes the pool on disk: refresh the provider activation and
    // the form's account list, and rebuild the account manager.
    const onCredentialsChanged = async () => {
      loader = undefined;
      pool = await loadPool();
      await ctx.provider.reload();
      await ctx.integration.reload();
      void discoverModels();
    };

    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = (event as { type?: string }).type;
          if (type === "credential.updated" || type === "credential.switched") {
            await onCredentialsChanged();
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          log.debug("event-subscription-ended", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();

    void discoverModels();

    return () => {
      abort.abort();
    };
  },
};

export default server;
