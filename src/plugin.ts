import { ANTIGRAVITY_DEFAULT_PROJECT_ID } from "./constants";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts } from "./plugin/auth";
import { ensureProjectContext } from "./plugin/project";
import { initializeDebug, shutdownDebug } from "./plugin/debug";
import { refreshAccessToken } from "./plugin/token";
import type { AccountManager } from "./plugin/accounts";
import { loadConfig, initRuntimeConfig, type AntigravityConfig } from "./plugin/config";
import { fetchAvailableModels } from "./plugin/quota";
import { initDiskSignatureCache, shutdownDiskSignatureCache } from "./plugin/cache";
import { createLogger } from "./plugin/logger";
import { initHealthTracker, initTokenTracker } from "./plugin/rotation";
import { initAntigravityVersion } from "./plugin/version";
import { executeSearch } from "./plugin/search";
import { fetchGeminiApiModels, getAgySdkCredentials, isApiKeyAuth } from "./plugin/api-key";
import {
  OPENCODE_MODEL_DEFINITIONS,
  mergeModelDefinitions,
  modelsFromAntigravityAvailableModels,
  modelsFromGeminiApi,
} from "./plugin/config/models";
import { recordPublicGeminiApiModels } from "./plugin/model-catalog";
import {
  SIGN_IN_HINT,
  __testExports as routerTestExports,
  createAntigravityRoute,
  loadActivePoolAuth,
} from "./plugin/router";
import type {
  AntigravityCore,
  AntigravityCoreOptions,
  AntigravityRoute,
  AuthDetails,
  CoreTool,
  GoogleSearchArgs,
  OAuthAuthDetails,
  ProviderModel,
} from "./plugin/types";
import { GOOGLE_SEARCH_INPUT_SCHEMA } from "./plugin/types";

/** The backend gates models on the client version; a long-running server re-checks it. */
const VERSION_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const log = createLogger("plugin");

async function modelsFromAgySdkCredentials(
  config: AntigravityConfig,
  auth: AuthDetails | undefined,
): Promise<Record<string, ProviderModel>> {
  if (!config.model_discovery.enabled || !config.model_discovery.gemini_api) return {};
  const credentials = getAgySdkCredentials(config, isApiKeyAuth(auth) ? auth : null);
  if (credentials.length === 0) return {};

  const errors: unknown[] = [];
  for (const credential of credentials) {
    try {
      const models = await fetchGeminiApiModels(credential);
      recordPublicGeminiApiModels(models);
      return modelsFromGeminiApi(models);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    log.debug("gemini-model-discovery-failed", { errors: errors.map((error) => String(error)) });
  }
  return {};
}

async function modelsFromOAuthAuth(
  config: AntigravityConfig,
  auth: AuthDetails | undefined,
): Promise<Record<string, ProviderModel>> {
  if (!config.model_discovery.enabled || !config.model_discovery.antigravity || !auth || !isOAuthAuth(auth)) return {};

  let accessToken = auth.access;
  if (!accessToken || accessTokenExpired(auth)) {
    const refreshed = await refreshAccessToken(auth);
    accessToken = refreshed?.access;
  }
  if (!accessToken) return {};

  const parts = parseRefreshParts(auth.refresh);
  const projectId = parts.managedProjectId || parts.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const response = await fetchAvailableModels(accessToken, projectId);
  return modelsFromAntigravityAvailableModels(response.models ?? {});
}

/**
 * User-facing Gemini model families intentionally removed from this plugin
 * (Gemini 2.5 Pro/Flash, Gemini 3 Pro, Gemini 3 Flash, Gemini 3.1 Flash
 * Lite/Image, Gemini 3.5/3.6/3.7 Flash). Filtered out of BOTH the static
 * definitions and anything surfaced by live model discovery or OpenCode's own
 * catalog, so they never reappear regardless of source. Kept models that share
 * a prefix (gemini-3.8-flash, gemini-3.1-pro) are preserved because the checks
 * match the removed families exactly: "gemini-3.1-pro" does not start with
 * "gemini-3-pro".
 */
export function isRemovedModelId(modelId: string): boolean {
  const id = modelId
    .toLowerCase()
    .replace(/^antigravity-/, "")
    .replace(/-(minimal|low|medium|high)$/, "");
  return (
    id.startsWith("gemini-2.5") ||
    id.startsWith("gemini-3-pro") ||
    id.startsWith("gemini-3-flash") ||
    id.startsWith("gemini-3.5-flash") ||
    id.startsWith("gemini-3.6-flash") ||
    id.startsWith("gemini-3.7-flash") ||
    id.startsWith("gemini-3.1-flash")
  );
}

/**
 * Lends OpenCode's still-valid access token to the pool account it belongs to
 * (same refresh token), sparing a token refresh. Any other credential is ignored.
 */
function withCredentialAccess(poolAuth: OAuthAuthDetails, credential: AuthDetails | undefined): OAuthAuthDetails {
  if (!credential || !isOAuthAuth(credential) || !credential.access || accessTokenExpired(credential)) {
    return poolAuth;
  }
  const sameAccount =
    parseRefreshParts(credential.refresh).refreshToken === parseRefreshParts(poolAuth.refresh).refreshToken;
  return sameAccount ? { ...poolAuth, access: credential.access, expires: credential.expires } : poolAuth;
}

/**
 * Creates the host-agnostic Antigravity core: account pool and request
 * routing, model discovery and the google_search tool.
 */
export async function createAntigravityCore({
  directory,
  options,
  getAuth,
  onAccountsRevoked,
}: AntigravityCoreOptions): Promise<AntigravityCore> {
  // Load configuration from files, environment variables, and plugin options
  const config = loadConfig(directory, options);
  initRuntimeConfig(config);

  // Initialize debug with config
  initializeDebug(config);

  // Fetch latest Antigravity version from remote API in the background (falls back
  // to hardcoded). Plugin setup must stay fast: OpenCode V2 gives plugins a few
  // seconds to activate. Model discovery and the loader wait for it, since the
  // reported version gates the backend's model catalog.
  const versionReady = initAntigravityVersion().catch(() => {});
  const versionRefresh = setInterval(() => {
    void initAntigravityVersion().catch(() => {});
  }, VERSION_REFRESH_INTERVAL_MS);
  versionRefresh.unref?.();

  // The pool built by the latest loader() call; google_search uses its accounts.
  let activeAccountManager: AccountManager | null = null;
  
  // Initialize health tracker for hybrid strategy
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score,
    });
  }

  // Initialize token tracker for hybrid strategy
  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens,
    });
  }
  
  // Initialize disk signature cache if keep_thinking is enabled
  // This integrates with the in-memory cacheSignature/getCachedSignature functions
  const diskSignatureCache = config.keep_thinking ? initDiskSignatureCache(config.signature_cache) : null;
  
  // Create google_search tool with access to auth context
  const googleSearchTool: CoreTool<GoogleSearchArgs> = {
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    input: GOOGLE_SEARCH_INPUT_SCHEMA,
    async execute(args, signal) {
      log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 });

      // Search as the pool account chat requests currently use; before the first
      // request, the pool's active account; OpenCode's credential only when the
      // pool is empty.
      const manager = activeAccountManager;
      const account = manager?.getCurrentAccountForFamily("gemini") ?? manager?.getEnabledAccounts()[0] ?? null;
      let auth: OAuthAuthDetails | undefined =
        manager && account ? manager.toAuthDetails(account) : await loadActivePoolAuth();
      if (!auth) {
        const credential = await getAuth().catch(() => undefined);
        if (credential && isOAuthAuth(credential)) {
          auth = credential;
        }
      }
      if (!auth) {
        return `Error: No Antigravity account. Run ${SIGN_IN_HINT} to add one.`;
      }

      if (!auth.access || accessTokenExpired(auth)) {
        try {
          const refreshed = await refreshAccessToken(auth);
          if (refreshed) {
            auth = refreshed;
            if (manager && account) {
              manager.updateFromAuth(account, refreshed);
            }
          }
        } catch (error) {
          return `Error: Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      const accessToken = auth.access;
      if (!accessToken) {
        return `Error: No valid access token available. Re-authenticate with ${SIGN_IN_HINT}.`;
      }

      let projectId: string;
      try {
        projectId = (await ensureProjectContext(auth)).effectiveProjectId;
      } catch (error) {
        return `Error: Could not resolve the Antigravity project: ${error instanceof Error ? error.message : String(error)}`;
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
        },
        accessToken,
        projectId,
        signal,
      );
    },
  };

  return {
    tool: {
      google_search: googleSearchTool,
    },
    async dispose(): Promise<void> {
      clearInterval(versionRefresh);
      shutdownDiskSignatureCache(diskSignatureCache);
      shutdownDebug();
    },
    async models(): Promise<Record<string, ProviderModel>> {
      await versionReady;
      if (!config.model_discovery.enabled) {
        return OPENCODE_MODEL_DEFINITIONS;
      }
      const auth = await getAuth().catch(() => undefined);

      // Antigravity discovery runs as the pool's active account (OpenCode's
      // credential only when the pool is empty); Gemini API discovery uses keys.
      const poolAuth = await loadActivePoolAuth().catch(() => undefined);
      const discoveryAuth = poolAuth ? withCredentialAccess(poolAuth, auth) : auth;
      const [geminiResult, antigravityResult] = await Promise.allSettled([
        modelsFromAgySdkCredentials(config, auth),
        modelsFromOAuthAuth(config, discoveryAuth),
      ]);

      const geminiModels = geminiResult.status === "fulfilled" ? geminiResult.value : {};
      const antigravityModels = antigravityResult.status === "fulfilled" ? antigravityResult.value : {};
      if (geminiResult.status === "rejected" || antigravityResult.status === "rejected") {
        log.debug("model-discovery-partial-fallback", {
          geminiError: geminiResult.status === "rejected" ? String(geminiResult.reason) : undefined,
          antigravityError: antigravityResult.status === "rejected" ? String(antigravityResult.reason) : undefined,
        });
      }

      return mergeModelDefinitions(OPENCODE_MODEL_DEFINITIONS, geminiModels, antigravityModels);
    },
    loader: async (): Promise<AntigravityRoute | undefined> => {
      await versionReady;
      let pool: AccountManager | undefined;
      const route = await createAntigravityRoute({
        config,
        getAuth,
        onAccountsRevoked,
        onPool: (manager) => {
          pool = manager;
          activeAccountManager = manager;
        },
      });
      if (!route) {
        return undefined;
      }
      return {
        fetch: route.fetch,
        async dispose() {
          if (pool && activeAccountManager === pool) {
            activeAccountManager = null;
          }
          await route.dispose();
        },
      };
    },
  };
}

export { loopEscapeTestHooks } from "./plugin/router";

export const __testExports = {
  ...routerTestExports,
  isRemovedModelId,
};
