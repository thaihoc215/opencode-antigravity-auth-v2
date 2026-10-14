/**
 * Request routing for the Antigravity core: picks a pool account for each
 * Gemini API request, refreshes its token, sends the request to the
 * Antigravity endpoints (with fallback between them and between the
 * Antigravity and Gemini CLI quotas), backs off and rotates on rate limits,
 * and falls back to Gemini API keys when configured.
 */
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  type HeaderStyle,
} from "../constants";
import { accessTokenExpired, isOAuthAuth, formatRefreshParts } from "./auth";
import { ensureProjectContext } from "./project";
import {
  startAntigravityDebugRequest,
  logAntigravityDebugResponse,
  logAccountContext,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  logModelFamily,
  isDebugEnabled,
  getLogFilePath,
  sanitizeUrlForLog,
} from "./debug";
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./request";
import { resolveModelWithTier } from "./transform/model-resolver";
import {
  isEmptyResponseBody,
  createSyntheticErrorResponse,
} from "./request-helpers";
import { EmptyResponseError } from "./errors";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import { loadAccounts } from "./storage";
import { AccountManager, type ModelFamily, parseRateLimitReason, calculateBackoffMs, computeSoftQuotaCacheTtlMs } from "./accounts";
import type { AntigravityConfig } from "./config";
import { checkAccountsQuota } from "./quota";
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./refresh-queue";
import { createLogger } from "./logger";
import { getHealthTracker, getTokenTracker } from "./rotation";
import { extractVerificationErrorDetails, isModelPermissionDeniedOnProjectError } from "./verification";
import {
  createAntigravityOnlyModelErrorResponse,
  extractRequestedGeminiModel,
  fetchWithAgySdkCredential,
  getAgySdkCredentials,
  isAgySdkSupportedRequest,
  isAntigravityOnlyGenerativeLanguageRequest,
  isApiKeyAuth,
  isRetryableAgySdkCredentialStatus,
  selectAgySdkCredential,
  type AgySdkCredential,
} from "./api-key";
import type {
  AntigravityRoute,
  AuthDetails,
  GetAuth,
  OAuthAuthDetails,
  ProjectContextResult,
} from "./types";

/** How to add accounts, for error messages. */
export const SIGN_IN_HINT = "`opencode auth login google --method antigravity`";

const MAX_WARMUP_SESSIONS = 1000;
const MAX_WARMUP_RETRIES = 2;
// Per-session warmup attempt counter. A plain Set can't enforce
// MAX_WARMUP_RETRIES (membership is only 0/1), so the retry cap was dead.
const warmupAttemptCounts = new Map<string, number>();
const warmupSucceededSessionIds = new Set<string>();

const log = createLogger("router");

const quotaRefreshInProgressByEmail = new Set<string>();

function defaultRetryMsForConfig(config: AntigravityConfig): number {
  return (config.default_retry_after_seconds ?? 60) * 1000;
}

async function tryFetchWithAgySdkCredentials(
  input: RequestInfo,
  init: RequestInit | undefined,
  credentials: AgySdkCredential[],
  fallbackRetryAfterMs: number,
): Promise<Response | null> {
  if (credentials.length === 0) return null;
  const attempted = new Set<string>();
  let lastResponse: Response | null = null;

  while (attempted.size < credentials.length) {
    const credential = selectAgySdkCredential(
      credentials.filter((candidate) => !attempted.has(candidate.apiKey)),
    );
    if (!credential) {
      break;
    }
    attempted.add(credential.apiKey);
    const response = await fetchWithAgySdkCredential(input, init, credential, fallbackRetryAfterMs);
    if (!isRetryableAgySdkCredentialStatus(response.status)) {
      return response;
    }
    lastResponse = response;
  }

  return lastResponse ?? new Response(
    JSON.stringify({ error: { message: "All Gemini API keys are temporarily rate-limited" } }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

async function tryAgySdkFallbackForRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  config: AntigravityConfig,
  credentials: AgySdkCredential[],
  urlString: string,
): Promise<Response | null> {
  if (!config.agy_sdk.api_key_fallback || credentials.length === 0 || !isAgySdkSupportedRequest(urlString)) {
    return null;
  }
  // Defensive: if the original request body was already consumed (e.g. `input` is a
  // Request whose stream was read upstream), re-sending it through the api-key path
  // would throw "body already used". Current callers pass a string body, so this is
  // latent — but bail gracefully (return null → caller surfaces its existing error
  // Response) rather than letting an unhandled TypeError crash the session.
  if (typeof input !== "string" && "bodyUsed" in input && (input as Request).bodyUsed) {
    log.warn("agy-sdk fallback skipped: original request body already consumed", {
      url: sanitizeUrlForLog(urlString),
    });
    return null;
  }
  return tryFetchWithAgySdkCredentials(
    input,
    init,
    credentials,
    defaultRetryMsForConfig(config),
  );
}

async function triggerAsyncQuotaRefreshForAccount(
  accountManager: AccountManager,
  accountIndex: number,
  intervalMinutes: number,
): Promise<void> {
  if (intervalMinutes <= 0) return;
  
  const accounts = accountManager.getAccounts();
  const account = accounts[accountIndex];
  if (!account || account.enabled === false) return;
  
  const accountKey = account.email ?? `idx-${accountIndex}`;
  if (quotaRefreshInProgressByEmail.has(accountKey)) return;
  
  const intervalMs = intervalMinutes * 60 * 1000;
  const age = account.cachedQuotaUpdatedAt != null 
    ? Date.now() - account.cachedQuotaUpdatedAt 
    : Infinity;
  
  if (age < intervalMs) return;
  
  quotaRefreshInProgressByEmail.add(accountKey);
  
  try {
    const accountsForCheck = accountManager.getAccountsForQuotaCheck();
    const singleAccount = accountsForCheck[accountIndex];
    if (!singleAccount) {
      quotaRefreshInProgressByEmail.delete(accountKey);
      return;
    }
    
    const results = await checkAccountsQuota([singleAccount]);
    
    if (results[0]?.status === "ok" && results[0]?.quota?.groups) {
      accountManager.updateQuotaCache(accountIndex, results[0].quota.groups);
      accountManager.requestSaveToDisk();
    }
  } catch (err) {
    log.debug(`quota-refresh-failed email=${accountKey}`, { error: String(err) });
  } finally {
    quotaRefreshInProgressByEmail.delete(accountKey);
  }
}

function trackWarmupAttempt(sessionId: string): boolean {
  if (warmupSucceededSessionIds.has(sessionId)) {
    return false;
  }
  const attempts = getWarmupAttemptCount(sessionId);
  if (attempts >= MAX_WARMUP_RETRIES) {
    return false;
  }
  // Evict the oldest entry ONLY when inserting a brand-new session. Evicting
  // before the has-check could delete the very session being retried (if it were
  // the oldest), resetting its count to 0 and defeating the cap.
  if (!warmupAttemptCounts.has(sessionId) && warmupAttemptCounts.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupAttemptCounts.keys().next().value;
    if (first !== undefined) {
      warmupAttemptCounts.delete(first);
      warmupSucceededSessionIds.delete(first);
    }
  }
  // Count this attempt up-front so failed attempts accrue toward the cap
  // (previously the failure path cleared the record, so the cap never engaged).
  warmupAttemptCounts.set(sessionId, attempts + 1);
  return true;
}

function getWarmupAttemptCount(sessionId: string): number {
  return warmupAttemptCounts.get(sessionId) ?? 0;
}

function markWarmupSuccess(sessionId: string): void {
  warmupSucceededSessionIds.add(sessionId);
  warmupAttemptCounts.delete(sessionId);
  if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupSucceededSessionIds.values().next().value;
    if (first) warmupSucceededSessionIds.delete(first);
  }
}

/**
 * OAuth auth for the active account of the pool in antigravity-accounts.json:
 * the stored `activeIndex` when that account is enabled, else the first enabled
 * account, else the first account with a refresh token. `undefined` when no
 * account has a refresh token. The access token is left empty for the caller
 * to refresh.
 */
export async function loadActivePoolAuth(): Promise<OAuthAuthDetails | undefined> {
  const storage = await loadAccounts();
  const accounts = storage?.accounts ?? [];
  const usable = (account: (typeof accounts)[number] | undefined) => !!account?.refreshToken;
  const active = accounts[storage?.activeIndex ?? 0];
  const account =
    (usable(active) && active?.enabled !== false ? active : undefined) ??
    accounts.find((candidate) => usable(candidate) && candidate.enabled !== false) ??
    accounts.find(usable);
  if (!account) {
    return undefined;
  }
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: "",
    expires: 0,
  };
}

function retryAfterMsFromResponse(response: Response, defaultRetryMs: number = 60_000): number {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const parsed = Number.parseInt(retryAfterMsHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const parsed = Number.parseInt(retryAfterHeader, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }

  return defaultRetryMs;
}

/**
 * Parse Go-style duration strings to milliseconds.
 * Supports compound durations: "1h16m0.667s", "1.5s", "200ms", "5m30s"
 * 
 * @param duration - Duration string in Go format
 * @returns Duration in milliseconds, or null if parsing fails
 */
function parseDurationToMs(duration: string): number | null {
  // Handle simple formats first for backwards compatibility
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!);
    const unit = (simpleMatch[2] || "s").toLowerCase();
    switch (unit) {
      case "h": return value * 3600 * 1000;
      case "m": return value * 60 * 1000;
      case "s": return value * 1000;
      case "ms": return value;
      default: return value * 1000;
    }
  }
  
  // Parse compound Go-style durations: "1h16m0.667s", "5m30s", etc.
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi;
  let totalMs = 0;
  let matchFound = false;
  let match = compoundRegex.exec(duration);
  while (match !== null) {
    matchFound = true;
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    switch (unit) {
      case "h": totalMs += value * 3600 * 1000; break;
      case "m": totalMs += value * 60 * 1000; break;
      case "s": totalMs += value * 1000; break;
      case "ms": totalMs += value; break;
    }
    match = compoundRegex.exec(duration);
  }
  
  return matchFound ? totalMs : null;
}

interface RateLimitBodyInfo {
  retryDelayMs: number | null;
  message?: string;
  quotaResetTime?: string;
  reason?: string;
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null };
  }

  const error = (body as { error?: unknown }).error;
  const message = error && typeof error === "object" 
    ? (error as { message?: string }).message 
    : undefined;

  const details = error && typeof error === "object" 
    ? (error as { details?: unknown[] }).details 
    : undefined;

  let reason: string | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason;
        if (typeof detailReason === "string") {
          reason = detailReason;
          break;
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay;
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay);
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason };
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const metadata = (detail as { metadata?: Record<string, string> }).metadata;
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay;
        const quotaResetTime = metadata.quotaResetTimeStamp;
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay);
          if (quotaResetDelayMs !== null) {
            return { retryDelayMs: quotaResetDelayMs, message, quotaResetTime, reason };
          }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
    const rawDuration = afterMatch?.[1];
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration);
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason };
      }
    }
  }

  return { retryDelayMs: null, message, reason };
}

async function extractRetryInfoFromBody(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text();
    try {
      const parsed = JSON.parse(text) as unknown;
      return extractRateLimitBodyInfo(parsed);
    } catch {
      return { retryDelayMs: null };
    }
  } catch {
    return { retryDelayMs: null };
  }
}

function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function createSoftQuotaBlockedResponse(input: {
  accountCount: number;
  family: ModelFamily;
  threshold: number;
  waitMs: number | null;
  requestedModel?: string;
}): Response {
  const waitTimeFormatted = input.waitMs ? formatWaitTime(input.waitMs) : "unknown";
  const errorMessage = [
    `[Antigravity Error] Quota protection: All ${input.accountCount} account(s) are over ${input.threshold}% usage for ${input.family}.`,
    `Quota resets in ${waitTimeFormatted}.`,
    "",
    "API-key fallback is disabled or unavailable, so the request was not routed to the public Gemini API.",
    "To continue, add more accounts, wait for quota reset, set soft_quota_threshold_percent: 100 to disable soft quota protection, or enable agy_sdk.api_key_fallback with a usable Gemini API key.",
  ].join("\n");
  return createSyntheticErrorResponse(errorMessage, input.requestedModel, input.family);
}

// Progressive rate limit retry delays
const FIRST_RETRY_DELAY_MS = 1000;      // 1s - first 429 quick retry on same account
const SWITCH_ACCOUNT_DELAY_MS = 5000;   // 5s - delay before switching to another account

/**
 * Rate limit state tracking with time-window deduplication.
 * 
 * Problem: When multiple subagents hit 429 simultaneously, each would increment
 * the consecutive counter, causing incorrect exponential backoff (5 concurrent
 * 429s = 2^5 backoff instead of 2^1).
 * 
 * Solution: Track per account+quota with deduplication window. Multiple 429s
 * within RATE_LIMIT_DEDUP_WINDOW_MS are treated as a single event.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000; // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000; // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitState {
  consecutive429: number;
  lastAt: number;
  quotaKey: string; // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

/**
 * Get rate limit backoff with time-window deduplication.
 * 
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-cli", "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
function getRateLimitBackoff(
  accountIndex: number, 
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now();
  const stateKey = `${accountIndex}:${quotaKey}`;
  const previous = rateLimitStateByAccountQuota.get(stateKey);
  
  // Check if this is a duplicate 429 within the dedup window
  if (previous && (now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS)) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000;
    const backoffDelay = Math.min(baseDelay * Math.pow(2, previous.consecutive429 - 1), maxBackoffMs);
    return { 
      attempt: previous.consecutive429, 
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true 
    };
  }
  
  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt = previous && (now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS) 
    ? previous.consecutive429 + 1 
    : 1;
  
  rateLimitStateByAccountQuota.set(stateKey, { 
    consecutive429: attempt, 
    lastAt: now,
    quotaKey 
  });
  
  const baseDelay = serverRetryAfterMs ?? 1000;
  const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxBackoffMs);
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false };
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`;
  rateLimitStateByAccountQuota.delete(stateKey);
}

function headerStyleToQuotaKey(headerStyle: HeaderStyle, family: ModelFamily): string {
  if (family === "claude") return "claude";
  return headerStyle === "antigravity" ? "gemini-antigravity" : "gemini-cli";
}

/**
 * Whether an endpoint is usable for the given header style. Gemini CLI models
 * only work against the production endpoint — sandbox endpoints are skipped.
 * Mirrors the skip check in the endpoint-fallback loop.
 */
function isEndpointUsableForHeaderStyle(endpoint: string, headerStyle: HeaderStyle): boolean {
  if (headerStyle === "gemini-cli" && endpoint !== ANTIGRAVITY_ENDPOINT_PROD) {
    return false;
  }
  return true;
}

/**
 * Whether any endpoint after `index` in ANTIGRAVITY_ENDPOINT_FALLBACKS is usable
 * for the given header style. Used to decide, after capacity retries are
 * exhausted on the current endpoint, whether trying the next endpoint can make
 * progress or whether we must switch accounts instead.
 */
function hasUsableEndpointAfterIndex(index: number, headerStyle: HeaderStyle): boolean {
  for (let j = index + 1; j < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; j++) {
    const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[j]
    if (endpoint && isEndpointUsableForHeaderStyle(endpoint, headerStyle)) {
      return true
    }
  }
  return false
}

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<number, { consecutiveFailures: number; lastFailureAt: number }>();
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 30_000; // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000; // Reset failure count after 2 minutes of no failures

function trackAccountFailure(accountIndex: number): { failures: number; shouldCooldown: boolean; cooldownMs: number } {
  const now = Date.now();
  const previous = accountFailureState.get(accountIndex);
  
  // Reset if last failure was more than 2 minutes ago
  const failures = previous && (now - previous.lastFailureAt < FAILURE_STATE_RESET_MS) 
    ? previous.consecutiveFailures + 1 
    : 1;
  
  accountFailureState.set(accountIndex, { consecutiveFailures: failures, lastFailureAt: now });
  
  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES;
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0;
  
  return { failures, shouldCooldown, cooldownMs };
}

function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex);
}

/**
 * Compute the new numeric index for a per-account state key after the account
 * at `removedIndex` has been spliced out and subsequent indices renumbered
 * down by one (see AccountManager.removeAccount). Returns null when the entry
 * belonged to the removed account and should be dropped.
 */
function remapIndexAfterRemoval(index: number, removedIndex: number): number | null {
  if (index === removedIndex) return null
  return index > removedIndex ? index - 1 : index
}

/**
 * Remap a Set of numeric account indices in place after an account removal.
 * Drops the removed index and shifts higher indices down by one so the set
 * keeps referring to the same accounts after renumbering.
 */
function remapIndexSetAfterRemoval(set: Set<number>, removedIndex: number): void {
  const values = [...set]
  set.clear()
  for (const index of values) {
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) set.add(next)
  }
}

/**
 * Remap all module-level per-account state after the account at `removedIndex`
 * is removed from the pool. AccountManager.removeAccount() splices the account
 * out and renumbers every subsequent account's index down by one; index-keyed
 * state here must follow suit or it silently attaches to the wrong account.
 * Also folds in the old resetAllRateLimitStateForAccount cleanup (the removed
 * account's rate-limit entries are dropped).
 */
function remapAccountStateAfterRemoval(removedIndex: number): void {
  // accountFailureState: Map<accountIndex, ...>
  const failureEntries = [...accountFailureState.entries()]
  accountFailureState.clear()
  for (const [index, state] of failureEntries) {
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) accountFailureState.set(next, state)
  }

  // rateLimitStateByAccountQuota: Map<`${accountIndex}:${quotaKey}`, ...>
  const rateEntries = [...rateLimitStateByAccountQuota.entries()]
  rateLimitStateByAccountQuota.clear()
  for (const [key, state] of rateEntries) {
    const sep = key.indexOf(":")
    const index = Number(key.slice(0, sep))
    const quotaKey = key.slice(sep + 1)
    if (sep < 0 || Number.isNaN(index)) {
      // Malformed key — preserve as-is rather than dropping silently.
      rateLimitStateByAccountQuota.set(key, state)
      continue
    }
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) rateLimitStateByAccountQuota.set(`${next}:${quotaKey}`, state)
  }

  // Trackers in rotation.ts are index-keyed too; keep them attached to the right accounts.
  getHealthTracker().remapAfterRemoval(removedIndex)
  getTokenTracker().remapAfterRemoval(removedIndex)
}

/**
 * Test-only hooks. NOT part of the plugin's runtime surface — exported so unit
 * tests can exercise the pure loop-escape / index-remap / warmup helpers and
 * inspect the index-keyed module state they mutate. Kept in one object to avoid
 * scattering `export` across internal helpers.
 */
export const loopEscapeTestHooks = {
  hasUsableEndpointAfterIndex,
  isEndpointUsableForHeaderStyle,
  resolveQuotaFallbackHeaderStyle,
  remapIndexAfterRemoval,
  remapIndexSetAfterRemoval,
  remapAccountStateAfterRemoval,
  trackWarmupAttempt,
  getWarmupAttemptCount,
  markWarmupSuccess,
  MAX_WARMUP_SESSIONS,
  seedAccountFailure(index: number, consecutiveFailures: number): void {
    accountFailureState.set(index, { consecutiveFailures, lastFailureAt: Date.now() })
  },
  getAccountFailureCount(index: number): number | undefined {
    return accountFailureState.get(index)?.consecutiveFailures
  },
  seedRateLimitState(index: number, quotaKey: string, consecutive429: number): void {
    rateLimitStateByAccountQuota.set(`${index}:${quotaKey}`, {
      consecutive429,
      lastAt: Date.now(),
      quotaKey,
    })
  },
  getRateLimitConsecutive(index: number, quotaKey: string): number | undefined {
    return rateLimitStateByAccountQuota.get(`${index}:${quotaKey}`)?.consecutive429
  },
  resetAllInternalState(): void {
    accountFailureState.clear()
    rateLimitStateByAccountQuota.clear()
    warmupAttemptCounts.clear()
    warmupSucceededSessionIds.clear()
  },
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RouteOptions {
  config: AntigravityConfig;
  /** Reads the host's current credential. */
  getAuth: GetAuth;
  /** See AntigravityCoreOptions.onAccountsRevoked. */
  onAccountsRevoked?: () => Promise<void>;
  /** Receives the account pool the route was built on. */
  onPool?: (manager: AccountManager) => void;
}

/**
 * Builds the account pool from antigravity-accounts.json (seeded from the
 * host's credential when the file does not exist) and the fetch that routes
 * Gemini API requests through it: account selection, token refresh, rate-limit
 * backoff and rotation, endpoint fallback, the API-key fallback, and response
 * transforms. `undefined` when there is neither an OAuth account nor a Gemini
 * API key to route with.
 */
export async function createAntigravityRoute({
  config,
  getAuth,
  onAccountsRevoked,
  onPool,
}: RouteOptions): Promise<AntigravityRoute | undefined> {

    const initialAuth = await getAuth();
    // Captured for the OAuth fetch handler's invalid_grant cleanup: only
    // report revoked credentials to the host when it WAS in OAuth mode at
    // loader time. If we promote OAuth from disk over an API-key auth
    // (oh-my-opencode case), its API-key connection is fine.
    const initialAuthWasOAuth = isOAuthAuth(initialAuth);
    const apiKeyAuth = isApiKeyAuth(initialAuth) ? initialAuth : null;
    const initialAgySdkCredentials = getAgySdkCredentials(config, apiKeyAuth);

    // Accounts live in antigravity-accounts.json. When OpenCode hands us
    // non-OAuth auth (no credential, or API-key mode such as oh-my-opencode's),
    // use the pool's active account so antigravity-* / Claude requests route
    // through the Antigravity OAuth backend instead of being short-circuited as
    // 404s by the API-key-only interceptor below.
    let auth: AuthDetails = initialAuth;
    if (!isOAuthAuth(initialAuth)) {
      auth = (await loadActivePoolAuth()) ?? initialAuth;
    }

    // No OAuth account anywhere. The pool file is left alone: it is the source
    // of truth, and loadAccounts() also reports an unreadable file (a typo from
    // a hand edit, a lock held by another process) as "no accounts". Accounts
    // are deleted through the account manager CLI only.
    if (!isOAuthAuth(auth)) {
      if (initialAgySdkCredentials.length === 0) {
        return undefined;
      }

      return {
        async dispose() {},
        async fetch(input, init) {
          const urlString = toUrlString(input);
          // Antigravity-only models (e.g. gemini-3.1-pro) can't be served by
          // the public Gemini API. Without OAuth there's no quota path that
          // can satisfy them, so short-circuit with actionable guidance
          // instead of forwarding to a guaranteed 404.
          if (isAntigravityOnlyGenerativeLanguageRequest(urlString)) {
            const requestedModel = extractRequestedGeminiModel(urlString);
            if (requestedModel) {
              return createAntigravityOnlyModelErrorResponse(requestedModel);
            }
          }
          if (!isAgySdkSupportedRequest(urlString)) {
            return fetch(input, init);
          }
          const latest = await getAuth();
          const latestCredentials = getAgySdkCredentials(config, isApiKeyAuth(latest) ? latest : apiKeyAuth);
          const response = await tryFetchWithAgySdkCredentials(
            input,
            init,
            latestCredentials,
            (config.default_retry_after_seconds ?? 60) * 1000,
          );
          if (response) return response;
          return fetch(input, init);
        },
      };
    }

    // The pool on disk is the source of truth for requests: `auth` only seeds it
    // when no antigravity-accounts.json exists yet, and lends its access token
    // to the pool account with the same refresh token.
    const accountManager = await AccountManager.loadFromDisk(auth);
    onPool?.(accountManager);
    if (accountManager.getAccountCount() > 0) {
      accountManager.requestSaveToDisk();
    }

    // Initialize proactive token refresh queue (ported from LLM-API-Key-Proxy)
    let refreshQueue: ProactiveRefreshQueue | null = null;
    if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
      refreshQueue = createProactiveRefreshQueue({
        enabled: config.proactive_token_refresh,
        bufferSeconds: config.proactive_refresh_buffer_seconds,
        checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
      });
      refreshQueue.setAccountManager(accountManager);
      refreshQueue.start();
    }

    if (isDebugEnabled()) {
      const logPath = getLogFilePath();
      if (logPath) {
        log.info(`Debug log: ${logPath}`);
      }
    }

    return {
      async dispose() {
        refreshQueue?.stop();
        await accountManager.dispose();
      },
      async fetch(input, init) {
        if (!isGenerativeLanguageRequest(input)) {
          return fetch(input, init);
        }

        // Fall back to the API-key-only sub-branch only when we have no
        // usable OAuth accounts (e.g. all were removed via invalid_grant).
        // Otherwise the OAuth/AccountManager flow below handles routing,
        // including the Antigravity SDK / Gemini API-key fallback when
        // quota is exhausted (see tryAgySdkFallbackForRequest).
        if (accountManager.getAccountCount() === 0) {
          const latestAuth = await getAuth();
          const latestCredentials = getAgySdkCredentials(config, isApiKeyAuth(latestAuth) ? latestAuth : null);
          const urlString = toUrlString(input);
          // Antigravity-only models can't be served by the public Gemini API
          // and there's no OAuth quota path available here — short-circuit
          // with actionable guidance instead of forwarding to a 404.
          if (isAntigravityOnlyGenerativeLanguageRequest(urlString)) {
            const requestedModel = extractRequestedGeminiModel(urlString);
            if (requestedModel) {
              return createAntigravityOnlyModelErrorResponse(requestedModel);
            }
          }
          if (isAgySdkSupportedRequest(urlString)) {
            const response = await tryFetchWithAgySdkCredentials(
              input,
              init,
              latestCredentials,
              (config.default_retry_after_seconds ?? 60) * 1000,
            );
            if (response) return response;
          }
          return fetch(input, init);
        }


        const urlString = toUrlString(input);
        const family = getModelFamilyFromUrl(urlString);
        const model = extractModelFromUrl(urlString);
        const agySdkCredentials = getAgySdkCredentials(config, apiKeyAuth);
        const debugLines: string[] = [];
        const pushDebug = (line: string) => {
          if (!isDebugEnabled()) return;
          debugLines.push(line);
        };
        pushDebug(`request=${sanitizeUrlForLog(urlString)}`);

        type FailureContext = {
          response: Response;
          streaming: boolean;
          debugContext: ReturnType<typeof startAntigravityDebugRequest>;
          requestedModel?: string;
          projectId?: string;
          endpoint?: string;
          effectiveModel?: string;
          sessionId?: string;
          toolDebugMissing?: number;
          toolDebugSummary?: string;
          toolDebugPayload?: string;
        };

        let lastFailure: FailureContext | null = null;
        let lastError: Error | null = null;
        const abortSignal = init?.signal ?? undefined;
        // Accounts already tried (and switched away from) within THIS request.
        // Excluded from re-selection so each "switch account" makes forward
        // progress instead of re-picking the same account forever. Cleared
        // after a rate-limit/quota wait, since resets may free accounts again.
        const triedSwitchIndices = new Set<number>();
        // Absolute safety net: bound total loop iterations so the request can
        // never spin the event loop, regardless of account/quota state.
        let loopGuard = 0;

        // Helper to check if request was aborted
        const checkAborted = () => {
          if (abortSignal?.aborted) {
            throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted");
          }
        };

        // Status updates (rate-limit waits, quota fallbacks) go to the plugin
        // log: a V2 server plugin has no way to show toasts.
        const notify = (message: string, variant: "info" | "warning" | "error") => {
          if (variant === "info") {
            log.info(message);
          } else {
            log.warn(message);
          }
        };

        // Empty non-streaming responses retried for this request (H9).
        let emptyResponseAttempts = 0;
        
        const hasOtherAccountWithAntigravity = (currentAccount: any): boolean => {
          if (family !== "gemini") return false;
          // Use AccountManager method which properly checks for disabled/cooling-down accounts
          return accountManager.hasOtherAccountWithAntigravityAvailable(currentAccount.index, family, model);
        };

        while (true) {
          // Check for abort at the start of each iteration
          checkAborted();
          
          const accountCount = accountManager.getAccountCount();
          // Safety net: a request can iterate at most a few times per account
          // (select -> refresh -> fetch/switch). If we blow far past that, the
          // routing is not converging (e.g. all accounts exhausted for an
          // Antigravity-only model) — give up gracefully instead of spinning.
          if (++loopGuard > Math.max(50, accountCount * 8)) {
            const guardFallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
            if (guardFallback) return guardFallback;
            throw lastError || new Error(
              `Antigravity request routing did not converge for ${model ?? family}. ` +
              `All ${accountCount} account(s) appear rate-limited or exhausted for this model. ` +
              `Run ${SIGN_IN_HINT} to add accounts or wait for quota reset.`,
            );
          }
          const routingDecision= resolveHeaderRoutingDecision(urlString, family, config);
          const {
            preferredHeaderStyle,
            explicitQuota,
            allowQuotaFallback,
          } = routingDecision;

          if (
            family === "gemini" &&
            config.agy_sdk.prefer_for_gemini &&
            !explicitQuota &&
            agySdkCredentials.length > 0 &&
            isAgySdkSupportedRequest(urlString)
          ) {
            const response = await tryFetchWithAgySdkCredentials(
              input,
              init,
              agySdkCredentials,
              (config.default_retry_after_seconds ?? 60) * 1000,
            );
            if (response && !isRetryableAgySdkCredentialStatus(response.status)) {
              return response;
            }
          }
          
          if (accountCount === 0) {
            const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
            if (response) return response;
            throw new Error(`No Antigravity accounts available. Run ${SIGN_IN_HINT}.`);
          }

          const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
            config.soft_quota_cache_ttl_minutes,
            config.quota_refresh_interval_minutes,
          );

          let selectedHeaderStyle = preferredHeaderStyle;
          let account = accountManager.getCurrentOrNextForFamily(
            family,
            model,
            config.account_selection_strategy,
            preferredHeaderStyle,
            config.pid_offset_enabled,
            config.soft_quota_threshold_percent,
            softQuotaCacheTtlMs,
            triedSwitchIndices,
          );

          if (!account && allowQuotaFallback) {
            const alternateHeaderStyle: HeaderStyle =
              preferredHeaderStyle === "antigravity" ? "gemini-cli" : "antigravity";
            account = accountManager.getCurrentOrNextForFamily(
              family,
              model,
              config.account_selection_strategy,
              alternateHeaderStyle,
              config.pid_offset_enabled,
              config.soft_quota_threshold_percent,
              softQuotaCacheTtlMs,
              triedSwitchIndices,
            );
            if (account) {
              selectedHeaderStyle = alternateHeaderStyle;
              pushDebug(
                `selected-by-fallback idx=${account.index} preferred=${preferredHeaderStyle} alternate=${alternateHeaderStyle}`,
              );
            }
          }
          
          if (!account) {
            // Every usable account was already tried (and switched away from)
            // during THIS request. Nothing left to route to, so give up
            // gracefully rather than waiting on accounts that won't recover
            // mid-request (this is the case that previously spun forever for
            // an Antigravity-only model whose antigravity pool is exhausted).
            if (accountCount > 0 && triedSwitchIndices.size >= accountCount) {
              // Terminal (last-resort) fallback: every account has been tried, so
              // there is nothing left to rotate to. Intentionally UNguarded — we
              // return whatever the SDK gives, even a retryable failure, as a
              // bubble-able Response (project convention: return a Response rather
              // than throw) instead of falling through to a bare error.
              const exhaustedFallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
              if (exhaustedFallback) return exhaustedFallback;
              if (lastFailure) {
                return transformAntigravityResponse(
                  lastFailure.response,
                  lastFailure.streaming,
                  lastFailure.debugContext,
                  lastFailure.requestedModel,
                  lastFailure.projectId,
                  lastFailure.endpoint,
                  lastFailure.effectiveModel,
                  lastFailure.sessionId,
                  lastFailure.toolDebugMissing,
                  lastFailure.toolDebugSummary,
                  lastFailure.toolDebugPayload,
                  debugLines,
                );
              }
              throw lastError || new Error(
                `All ${accountCount} Antigravity account(s) are rate-limited for ${model ?? family}. ` +
                `Run ${SIGN_IN_HINT} to add accounts or wait for quota reset.`,
              );
            }
            if (accountManager.areAllAccountsOverSoftQuota(
              family,
              config.soft_quota_threshold_percent,
              softQuotaCacheTtlMs,
              model,
              preferredHeaderStyle,
            )) {
              const threshold = config.soft_quota_threshold_percent;
              const softQuotaWaitMs = accountManager.getMinWaitTimeForSoftQuota(
                family,
                threshold,
                softQuotaCacheTtlMs,
                model,
                preferredHeaderStyle,
              );
              const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
              const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
              if (response) return response;
              
              if (softQuotaWaitMs === null || (maxWaitMs > 0 && softQuotaWaitMs > maxWaitMs)) {
                const waitTimeFormatted = softQuotaWaitMs ? formatWaitTime(softQuotaWaitMs) : "unknown";
                notify(
                  `All accounts over ${threshold}% quota threshold. Resets in ${waitTimeFormatted}.`,
                  "error"
                );
                return createSoftQuotaBlockedResponse({
                  accountCount,
                  family,
                  threshold,
                  waitMs: softQuotaWaitMs,
                  requestedModel: model ?? undefined,
                });
              }
              
              pushDebug(`all-over-soft-quota family=${family} accounts=${accountCount} waitMs=${softQuotaWaitMs}`);
              
              notify(`All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime(softQuotaWaitMs)}...`, "warning");
              
              triedSwitchIndices.clear();
              await sleep(softQuotaWaitMs, abortSignal);
              continue;
            }

            const strictWait = !allowQuotaFallback;
            // All accounts are rate-limited - wait and retry
            const waitMs = accountManager.getMinWaitTimeForFamily(
              family,
              model,
              preferredHeaderStyle,
              strictWait,
            ) || 60_000;
            const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000));

            pushDebug(`all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`);
            if (isDebugEnabled()) {
              logAccountContext("All accounts rate-limited", {
                index: -1,
                family,
                totalAccounts: accountCount,
              });
              logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
            }

            // If wait time exceeds max threshold, return error immediately instead of hanging
            // 0 means disabled (wait indefinitely)
            const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
            const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
            if (response) return response;
            if (maxWaitMs > 0 && waitMs > maxWaitMs) {
              const waitTimeFormatted = formatWaitTime(waitMs);
              notify(
                `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
                "error"
              );
              
              // Return a proper rate limit error response
              throw new Error(
                `All ${accountCount} account(s) rate-limited for ${family}. ` +
                `Quota resets in ${waitTimeFormatted}. ` +
                `Add more accounts with ${SIGN_IN_HINT} or wait and retry.`
              );
            }

            notify(`All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`, "warning");

            // Wait for the rate-limit cooldown to expire, then retry
            triedSwitchIndices.clear();
            await sleep(waitMs, abortSignal);
            continue;
          }

pushDebug(
            `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`,
          );
          if (isDebugEnabled()) {
            logAccountContext("Selected", {
              index: account.index,
              email: account.email,
              family,
              totalAccounts: accountCount,
              rateLimitState: account.rateLimitResetTimes,
            });
          }

          let authRecord = accountManager.toAuthDetails(account);

          if (accessTokenExpired(authRecord)) {
            try {
              const refreshed = await refreshAccessToken(authRecord);
              if (!refreshed) {
                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                getHealthTracker().recordFailure(account.index);
                lastError = new Error("Antigravity token refresh failed");
                if (shouldCooldown) {
                  accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                  accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                  pushDebug(`token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                continue;
              }
              resetAccountFailureState(account.index);
              accountManager.updateFromAuth(account, refreshed);
              authRecord = refreshed;
              try {
                await accountManager.saveToDisk();
              } catch (error) {
                log.error("Failed to persist refreshed auth", { error: String(error) });
              }
            } catch (error) {
              if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                // Capture the index BEFORE removal — removeAccount renumbers all
                // subsequent accounts, so index-keyed state must be remapped to match.
                const removedIndex = account.index;
                const removed = accountManager.removeAccount(account);
                if (removed) {
                  remapAccountStateAfterRemoval(removedIndex);
                  remapIndexSetAfterRemoval(triedSwitchIndices, removedIndex);
                  log.warn(`Removed revoked account from pool - sign it in again with ${SIGN_IN_HINT}`);
                  try {
                    await accountManager.persistAccountRemoval(account.parts.refreshToken);
                  } catch (persistError) {
                    log.error("Failed to persist revoked account removal", { error: String(persistError) });
                  }
                }

                if (accountManager.getAccountCount() === 0) {
                  // Only report revoked credentials when OpenCode was actually in
                  // OAuth mode at loader time. If we promoted OAuth from disk
                  // over an API-key auth, OpenCode's API-key connection is fine.
                  if (initialAuthWasOAuth && onAccountsRevoked) {
                    try {
                      await onAccountsRevoked();
                    } catch (reportError) {
                      log.error("Failed to report revoked Antigravity credentials", { error: String(reportError) });
                    }
                  }

                  // Mixed-mode safety net: when promoted-from-disk OAuth fully
                  // fails but OpenCode has api-key auth (or env keys are configured)
                  // and the model is routable via the public Gemini API, attempt
                  // the api-key fallback before declaring the request unservable.
                  // OAuth-only setups still see the helpful "invalid refresh tokens"
                  // message since `tryAgySdkFallbackForRequest` returns null when
                  // no api-key credentials are available.
                  const fallback = await tryAgySdkFallbackForRequest(
                    input,
                    init,
                    config,
                    agySdkCredentials,
                    urlString,
                  );
                  if (fallback) return fallback;

                  throw new Error(
                    `All Antigravity accounts have invalid refresh tokens. Sign in again with ${SIGN_IN_HINT}.`,
                  );
                }

                lastError = error;
                continue;
              }

              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
              getHealthTracker().recordFailure(account.index);
              lastError = error instanceof Error ? error : new Error(String(error));
              if (shouldCooldown) {
                accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                pushDebug(`token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`);
              }
              continue;
            }
          }

          const accessToken = authRecord.access;
          if (!accessToken) {
            lastError = new Error("Missing access token");
            if (accountCount <= 1) {
              throw lastError;
            }
            continue;
          }

          let projectContext: ProjectContextResult;
          try {
            projectContext = await ensureProjectContext(authRecord);
            resetAccountFailureState(account.index);
          } catch (error) {
            const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
            getHealthTracker().recordFailure(account.index);
            lastError = error instanceof Error ? error : new Error(String(error));
            if (shouldCooldown) {
              accountManager.markAccountCoolingDown(account, cooldownMs, "project-error");
              accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
              pushDebug(`project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`);
            }
            continue;
          }

          if (projectContext.auth.refresh !== authRecord.refresh || 
              projectContext.auth.access !== authRecord.access) {
            accountManager.updateFromAuth(account, projectContext.auth);
            authRecord = projectContext.auth;
            try {
              await accountManager.saveToDisk();
            } catch (error) {
              log.error("Failed to persist project context", { error: String(error) });
            }
          }

          const runThinkingWarmup = async (
            prepared: Awaited<ReturnType<typeof prepareAntigravityRequest>>,
            projectId: string,
          ): Promise<void> => {
            if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) {
              return;
            }

            if (!trackWarmupAttempt(prepared.sessionId)) {
              return;
            }

            const warmupBody = buildThinkingWarmupBody(
              typeof prepared.init.body === "string" ? prepared.init.body : undefined,
              Boolean(prepared.effectiveModel?.toLowerCase().includes("claude") && prepared.effectiveModel?.toLowerCase().includes("thinking")),
            );
            if (!warmupBody) {
              return;
            }

            const warmupUrl = toWarmupStreamUrl(prepared.request);
            const warmupHeaders = new Headers(prepared.init.headers ?? {});
            warmupHeaders.set("accept", "text/event-stream");

            const warmupInit: RequestInit = {
              ...prepared.init,
              method: prepared.init.method ?? "POST",
              headers: warmupHeaders,
              body: warmupBody,
            };

            const warmupDebugContext = startAntigravityDebugRequest({
              originalUrl: warmupUrl,
              resolvedUrl: warmupUrl,
              method: warmupInit.method,
              headers: warmupHeaders,
              body: warmupBody,
              streaming: true,
              projectId,
            });

            try {
              pushDebug("thinking-warmup: start");
              const warmupResponse = await fetch(warmupUrl, warmupInit);
              const transformed = await transformAntigravityResponse(
                warmupResponse,
                true,
                warmupDebugContext,
                prepared.requestedModel,
                projectId,
                warmupUrl,
                prepared.effectiveModel,
                prepared.sessionId,
              );
              await transformed.text();
              markWarmupSuccess(prepared.sessionId);
              pushDebug("thinking-warmup: done");
            } catch (error) {
              // Do NOT clear the attempt on failure — failed warmups must count
              // toward MAX_WARMUP_RETRIES so a session that always fails warmup
              // stops retrying after the cap instead of priming every request.
              pushDebug(
                `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };

          // Try endpoint fallbacks with single header style based on model suffix
          let shouldSwitchAccount = false;
          
          // Determine header style from model suffix:
          // - Models with antigravity- prefix -> use Antigravity quota
          // - Gemini models without explicit prefix -> follow cli_first
          // - Claude models -> always use Antigravity
          let headerStyle = selectedHeaderStyle;
          pushDebug(`headerStyle=${headerStyle} explicit=${explicitQuota}`);
          if (account.fingerprint) {
            pushDebug(`fingerprint: quotaUser=${account.fingerprint.quotaUser} deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`);
          }
          
          // Check if this header style is rate-limited for this account
          if (accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle, model)) {
            // Antigravity-first fallback: exhaust antigravity across ALL accounts before gemini-cli
            if (allowQuotaFallback && family === "gemini" && headerStyle === "antigravity") {
              // Check if ANY other account has antigravity available
              if (accountManager.hasOtherAccountWithAntigravityAvailable(account.index, family, model)) {
                // Switch to another account with antigravity (preserve antigravity priority)
                pushDebug(`antigravity rate-limited on account ${account.index}, but available on other accounts. Switching.`);
                shouldSwitchAccount = true;
              } else {
                // All accounts exhausted antigravity - fall back to gemini-cli on this account
                const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                  family,
                  headerStyle,
                  alternateStyle,
                });
                if (fallbackStyle) {
                  notify(
                    `Antigravity quota exhausted on all accounts. Using Gemini CLI quota.`,
                    "warning"
                  );
                  headerStyle = fallbackStyle;
                  pushDebug(`all-accounts antigravity exhausted, quota fallback: ${headerStyle}`);
                } else {
                  shouldSwitchAccount = true;
                }
              }
            } else if (allowQuotaFallback && family === "gemini") {
              // gemini-cli rate-limited - try alternate style (antigravity) on same account
              const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
              const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                family,
                headerStyle,
                alternateStyle,
              });
              if (fallbackStyle) {
                const quotaName = headerStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
                const altQuotaName = fallbackStyle === "gemini-cli" ? "Gemini CLI" : "Antigravity";
                notify(
                  `${quotaName} quota exhausted, using ${altQuotaName} quota`,
                  "warning"
                );
                headerStyle = fallbackStyle;
                pushDebug(`quota fallback: ${headerStyle}`);
              } else {
                shouldSwitchAccount = true;
              }
            } else {
              shouldSwitchAccount = true;
            }
          }
          
          while (!shouldSwitchAccount) {
          
          // Flag to force thinking recovery on retry after API error
          let forceThinkingRecovery = false;
          
          // Track if token was consumed (for hybrid strategy refund on error)
          let tokenConsumed = false;
          
          // Track capacity retries per endpoint to prevent infinite loops
          let capacityRetryCount = 0;
          let lastEndpointIndex = -1;
          
          for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
            // Reset capacity retry counter when switching to a new endpoint
            if (i !== lastEndpointIndex) {
              capacityRetryCount = 0;
              lastEndpointIndex = i;
            }

            const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];

            // Skip sandbox endpoints for Gemini CLI models - they only work with Antigravity quota
            // Gemini CLI models must use production endpoint (cloudcode-pa.googleapis.com)
            if (headerStyle === "gemini-cli" && currentEndpoint !== ANTIGRAVITY_ENDPOINT_PROD) {
              pushDebug(`Skipping sandbox endpoint ${currentEndpoint} for gemini-cli headerStyle`);
              continue;
            }

            try {
              const prepared = await prepareAntigravityRequest(
                input,
                init,
                accessToken,
                projectContext.effectiveProjectId,
                currentEndpoint,
                headerStyle,
                forceThinkingRecovery,
                {
                  claudeToolHardening: config.claude_tool_hardening,
                  claudePromptAutoCaching: config.claude_prompt_auto_caching,
                  fingerprint: account.fingerprint,
                },
              );

              const originalUrl = toUrlString(input);
              const resolvedUrl = toUrlString(prepared.request);
              pushDebug(`endpoint=${currentEndpoint}`);
              pushDebug(`resolved=${sanitizeUrlForLog(resolvedUrl)}`);
              const debugContext = startAntigravityDebugRequest({
                originalUrl,
                resolvedUrl,
                method: prepared.init.method,
                headers: prepared.init.headers,
                body: prepared.init.body,
                streaming: prepared.streaming,
                projectId: projectContext.effectiveProjectId,
              });

              const createFailureContext = (failureResponse: Response): FailureContext => ({
                response: failureResponse,
                streaming: prepared.streaming,
                debugContext,
                requestedModel: prepared.requestedModel,
                projectId: prepared.projectId,
                endpoint: prepared.endpoint,
                effectiveModel: prepared.effectiveModel,
                sessionId: prepared.sessionId,
                toolDebugMissing: prepared.toolDebugMissing,
                toolDebugSummary: prepared.toolDebugSummary,
                toolDebugPayload: prepared.toolDebugPayload,
              });

              await runThinkingWarmup(prepared, projectContext.effectiveProjectId);

              if (config.request_jitter_max_ms > 0) {
                const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms);
                if (jitterMs > 0) {
                  await sleep(jitterMs, abortSignal);
                }
              }

              // Consume token for hybrid strategy
              // Refunded later if request fails (429 or network error)
              if (config.account_selection_strategy === 'hybrid') {
                tokenConsumed = getTokenTracker().consume(account.index);
              }

              let response = await fetch(prepared.request, prepared.init);
              pushDebug(`status=${response.status} ${response.statusText}`);

              // A successful non-streaming body is read once here; the empty-body
              // check, the debug log and the response transform use that copy
              // instead of each cloning and reading the network stream.
              let bufferedBody: string | undefined;
              if (response.ok && !prepared.streaming) {
                bufferedBody = await response.text();
                response = new Response(bufferedBody, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }




              // Handle 429 rate limit (or Service Overloaded) with improved logic
              if (response.status === 429 || response.status === 503 || response.status === 529) {
                // Refund token on rate limit
                if (tokenConsumed) {
                  getTokenTracker().refund(account.index);
                  tokenConsumed = false;
                }

                const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000;
                const headerRetryMs = retryAfterMsFromResponse(response, defaultRetryMs);
                const bodyInfo = await extractRetryInfoFromBody(response);
                const serverRetryMs = bodyInfo.retryDelayMs ?? headerRetryMs;

                // [Enhanced Parsing] Pass status to handling logic
                const rateLimitReason = parseRateLimitReason(bodyInfo.reason, bodyInfo.message, response.status);

                // STRATEGY 1: CAPACITY / SERVER ERROR (Transient)
                // Goal: Wait and Retry SAME Account. DO NOT LOCK.
                // We handle this FIRST to avoid calling getRateLimitBackoff() and polluting the global rate limit state for transient errors.
                if (rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" || rateLimitReason === "SERVER_ERROR") {
                   // Retry the SAME account/endpoint a bounded number of times with
                   // exponential backoff (1s → 2s → 4s → 8s max, ±10% jitter to avoid a
                   // thundering herd). Only the retrying path toasts and sleeps — the
                   // terminal (4th) failure must escape immediately, without a misleading
                   // "retrying" toast or a wasted multi-second wait.
                   if (capacityRetryCount < 3) {
                     const baseDelayMs = 1000;
                     const maxDelayMs = 8000;
                     const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, capacityRetryCount), maxDelayMs);
                     const jitter = exponentialDelay * (0.9 + Math.random() * 0.2);
                     const waitMs = Math.round(jitter);
                     const waitSec = Math.round(waitMs / 1000);

                     pushDebug(`Server busy (${rateLimitReason}) on account ${account.index}, exponential backoff ${waitMs}ms (attempt ${capacityRetryCount + 1})`);
                     notify(
                       `⏳ Server busy (${response.status}). Retrying in ${waitSec}s...`,
                       "warning",
                     );
                     await sleep(waitMs, abortSignal);

                     // Decrement i so the loop 'continue' retries the SAME endpoint index
                     // (the for-loop's i++ brings it back to the current index).
                     capacityRetryCount++;
                     i -= 1;
                     continue;
                   }

                   // Capacity retries exhausted for this endpoint.
                   pushDebug(`Max capacity retries (3) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`);
                   // Regenerate fingerprint to get a fresh device identity before trying elsewhere.
                   const newFingerprint = accountManager.regenerateAccountFingerprint(account.index);
                   if (newFingerprint) {
                     pushDebug(`Fingerprint regenerated for account ${account.index}`);
                   }

                   // Prefer the next usable endpoint on the SAME header style (existing behavior).
                   if (hasUsableEndpointAfterIndex(i, headerStyle)) {
                     continue;
                   }

                   // No further usable endpoint for this header style. Falling through to the
                   // for-loop's natural exit would let `while (!shouldSwitchAccount)` re-enter,
                   // reset capacityRetryCount to 0, and spin this SAME account forever (the
                   // outer loopGuard/account-rotation is never reached). For gemini-cli, PROD
                   // is the only usable endpoint, so this is the common case.
                   //
                   // Before excluding the WHOLE account, give the alternate quota pool + SDK
                   // fallback a chance on the SAME account (e.g. antigravity capacity-exhausted
                   // but gemini-cli quota still fine), mirroring STRATEGY 2. Marking the current
                   // (transient) pool rate-limited BEFORE getAvailableHeaderStyle is required so
                   // it returns the ALTERNATE style rather than the still-unmarked current one.
                   accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs);

                   if (family === "gemini" && allowQuotaFallback) {
                     const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                     const fallbackStyle = resolveQuotaFallbackHeaderStyle({ family, headerStyle, alternateStyle });
                     if (fallbackStyle) {
                       const safeModelName = model || "this model";
                       const currentQuotaName = headerStyle === "antigravity" ? "Antigravity" : "Gemini CLI";
                       notify(
                         `Server busy on ${currentQuotaName} quota for ${safeModelName}. Trying alternate quota...`,
                         "warning",
                       );
                       headerStyle = fallbackStyle;
                       pushDebug(`capacity fallback: ${headerStyle}`);
                       continue;
                     }
                   }

                   // Try the Antigravity SDK / Gemini API-key fallback before giving up the account.
                   // Only a SUCCESSFUL / non-retryable SDK response is terminal — tryFetch...()
                   // can return its last RETRYABLE failure (401/403/429/500/502/503/504/529, see
                   // isRetryableAgySdkCredentialStatus). Returning that would strand a healthy OAuth
                   // account that never got tried, so on a retryable SDK failure we fall through to
                   // account rotation (same guard as the prefer_for_gemini path).
                   const capacityAgySdkFallback = await tryAgySdkFallbackForRequest(
                     input,
                     init,
                     config,
                     agySdkCredentials,
                     urlString,
                   );
                   if (capacityAgySdkFallback && !isRetryableAgySdkCredentialStatus(capacityAgySdkFallback.status)) {
                     return capacityAgySdkFallback;
                   }

                   // Both quota pools exhausted and no SDK fallback — escape to the outer
                   // account-rotation loop (loopGuard + rotation apply there).
                   pushDebug(
                     `No further usable endpoint or quota for headerStyle=${headerStyle} after capacity exhaustion; switching account`,
                   );
                   lastError = new Error(
                     `Model capacity exhausted (${rateLimitReason}) on account ${account.index} after ${capacityRetryCount} retries`,
                   );
                   lastFailure = createFailureContext(response);
                   shouldSwitchAccount = true;
                   break;
                }

                // STRATEGY 2: RATE LIMIT EXCEEDED (RPM) / QUOTA EXHAUSTED / UNKNOWN
                // Goal: Lock and Rotate (Standard Logic)
                
                // Only now do we call getRateLimitBackoff, which increments the global failure tracker
                const quotaKey = headerStyleToQuotaKey(headerStyle, family);
                const { attempt, delayMs } = getRateLimitBackoff(account.index, quotaKey, serverRetryMs);
                
                // Calculate potential backoffs
                const smartBackoffMs = calculateBackoffMs(rateLimitReason, account.consecutiveFailures ?? 0, serverRetryMs);
                const effectiveDelayMs = Math.max(delayMs, smartBackoffMs);

                pushDebug(
                  `429 idx=${account.index} email=${account.email ?? ""} family=${family} delayMs=${effectiveDelayMs} attempt=${attempt} reason=${rateLimitReason}`,
                );
                if (bodyInfo.message) {
                  pushDebug(`429 message=${bodyInfo.message}`);
                }
                if (bodyInfo.quotaResetTime) {
                  pushDebug(`429 quotaResetTime=${bodyInfo.quotaResetTime}`);
                }
                if (bodyInfo.reason) {
                  pushDebug(`429 reason=${bodyInfo.reason}`);
                }

                 logRateLimitEvent(
                  account.index,
                  account.email,
                  family,
                  response.status,
                  effectiveDelayMs,
                  bodyInfo,
                );

                await logResponseBody(debugContext, response, 429);

                getHealthTracker().recordRateLimit(account.index);

                // Progressive retry for standard 429s: 1st 429 → 1s then switch (if enabled) or retry same
                if (attempt === 1 && rateLimitReason !== "QUOTA_EXHAUSTED") {
                  notify(`Rate limited. Quick retry in 1s...`, "warning");
                  await sleep(FIRST_RETRY_DELAY_MS, abortSignal);
                  
                  // CacheFirst mode: wait for same account if within threshold (preserves prompt cache)
                  if (config.scheduling_mode === 'cache_first') {
                    const maxCacheFirstWaitMs = config.max_cache_first_wait_seconds * 1000;
                    // effectiveDelayMs is the backoff calculated for this account
                    if (effectiveDelayMs <= maxCacheFirstWaitMs) {
                      pushDebug(`cache_first: waiting ${effectiveDelayMs}ms for same account to recover`);
                      notify(`⏳ Waiting ${Math.ceil(effectiveDelayMs / 1000)}s for same account (prompt cache preserved)...`, "info");
                      accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs);
                      await sleep(effectiveDelayMs, abortSignal);
                      // Retry same endpoint after wait
                      i -= 1;
                      continue;
                    }
                    // Wait time exceeds threshold, fall through to switch
                    pushDebug(`cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`);
                  }
                  
                  if (config.switch_on_first_rate_limit && accountCount > 1) {
                    accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);
                    shouldSwitchAccount = true;
                    break;
                  }
                  
                  // Same endpoint retry for first RPM hit
                  i -= 1; 
                  continue;
                }

                accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);

                accountManager.requestSaveToDisk();

                // For Gemini, preserve preferred quota across accounts before fallback
                if (family === "gemini") {
                  if (headerStyle === "antigravity") {
                    // Check if any other account has Antigravity quota for this model
                    if (hasOtherAccountWithAntigravity(account)) {
                      pushDebug(`antigravity exhausted on account ${account.index}, but available on others. Switching account.`);
                      notify(`Rate limited again. Switching account in 5s...`, "warning");
                      await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                      shouldSwitchAccount = true;
                      break;
                    }

                    // All accounts exhausted for Antigravity on THIS model.
                    // Before falling back to gemini-cli, check if it's the last option (automatic fallback)
                    if (allowQuotaFallback) {
                      const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                      const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                        family,
                        headerStyle,
                        alternateStyle,
                      });
                      if (fallbackStyle) {
                        const safeModelName = model || "this model";
                        notify(
                          `Antigravity quota exhausted for ${safeModelName}. Switching to Gemini CLI quota...`,
                          "warning"
                        );
                        headerStyle = fallbackStyle;
                        pushDebug(`quota fallback: ${headerStyle}`);
                        continue;
                      }
                    }
                  } else if (headerStyle === "gemini-cli") {
                    if (allowQuotaFallback) {
                      const alternateStyle = accountManager.getAvailableHeaderStyle(account, family, model);
                      const fallbackStyle = resolveQuotaFallbackHeaderStyle({
                        family,
                        headerStyle,
                        alternateStyle,
                      });
                      if (fallbackStyle) {
                        const safeModelName = model || "this model";
                        notify(
                          `Gemini CLI quota exhausted for ${safeModelName}. Switching to Antigravity quota...`,
                          "warning"
                        );
                        headerStyle = fallbackStyle;
                        pushDebug(`quota fallback: ${headerStyle}`);
                        continue;
                      }
                    }
                  }
                }

                const agySdkFallbackResponse = await tryAgySdkFallbackForRequest(
                  input,
                  init,
                  config,
                  agySdkCredentials,
                  urlString,
                );
                // Only a SUCCESSFUL / non-retryable SDK response is terminal here.
                // tryFetch...() can return its last RETRYABLE failure (401/403/429/
                // 500/502/503/504/529, see isRetryableAgySdkCredentialStatus); returning
                // that would short-circuit the account rotation below (shouldSwitchAccount)
                // and strand a healthy account. On a retryable SDK failure, fall through
                // to rotate.
                if (agySdkFallbackResponse && !isRetryableAgySdkCredentialStatus(agySdkFallbackResponse.status)) {
                  return agySdkFallbackResponse;
                }

                if (accountCount > 1) {
                  const quotaMsg = bodyInfo.quotaResetTime 
                    ? ` (quota resets ${bodyInfo.quotaResetTime})`
                    : ``;
                  notify(`Rate limited again. Switching account in 5s...${quotaMsg}`, "warning");
                  await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                } else {
                  // Single account: exponential backoff (1s, 2s, 4s, 8s... max 60s)
                  const expBackoffMs = Math.min(FIRST_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 60000);
                  const expBackoffFormatted = expBackoffMs >= 1000 ? `${Math.round(expBackoffMs / 1000)}s` : `${expBackoffMs}ms`;
                  notify(`Rate limited. Retrying in ${expBackoffFormatted} (attempt ${attempt})...`, "warning");
                  await sleep(expBackoffMs, abortSignal);
                }

                lastFailure = createFailureContext(response);
                shouldSwitchAccount = true;
                break;
              }

              // Success - reset rate limit backoff state for this quota
              const quotaKey = headerStyleToQuotaKey(headerStyle, family);
              resetRateLimitState(account.index, quotaKey);
              resetAccountFailureState(account.index);

              let permissionDeniedOnProject = false;
              if (response.status === 403) {
                const errorBodyText = await response.clone().text().catch(() => "");
                const extracted = extractVerificationErrorDetails(errorBodyText);

                if (extracted.validationRequired) {
                  const verificationReason = extracted.message ?? "Google requires account verification.";
                  const cooldownMs = 10 * 60 * 1000;

                  accountManager.markAccountVerificationRequired(account.index, verificationReason, extracted.verifyUrl);
                  accountManager.markAccountCoolingDown(account, cooldownMs, "validation-required");
                  accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);

                  const label = account.email || `Account ${account.index + 1}`;
                  notify(
                    `${label} needs Google verification and was disabled. Verify it in the account manager (bunx opencode-antigravity-auth).`,
                    "warning",
                  );

                  pushDebug(`verification-required: disabled account ${account.index}`);
                  getHealthTracker().recordFailure(account.index);

                  lastFailure = createFailureContext(response);
                  shouldSwitchAccount = true;
                  break;
                }

                // Some 403s are not credential/verification problems but a
                // project-scoped entitlement gate on this specific backend
                // model id (e.g. a staged rollout of a new variant). See
                // isModelPermissionDeniedOnProjectError for details.
                permissionDeniedOnProject = isModelPermissionDeniedOnProjectError(errorBodyText);
              }

              const shouldRetryEndpoint = (
                (response.status === 403 && !permissionDeniedOnProject) ||
                response.status === 404 ||
                response.status >= 500
              );

              if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                await logResponseBody(debugContext, response, response.status);
                lastFailure = createFailureContext(response);
                continue;
              }

              // Non-retryable model-availability failure from the Antigravity backend.
              // A 404 NOT_FOUND means this model isn't served for this account here
              // (e.g. a Gemini id the Antigravity Code Assist backend doesn't expose).
              // A 403 PERMISSION_DENIED with "Permission denied on resource project"
              // means the resolved backend model id isn't entitled for this managed
              // project (e.g. a staged Google rollout gate) — same practical effect as
              // a 404 from the caller's perspective. In both cases retrying other
              // endpoints or accounts can't help, but the public Gemini API (api-key
              // path) may serve it. Fall back to the agy-sdk SDK/API path so a model
              // that's unavailable on Antigravity but available via the API key still
              // succeeds. This mirrors the 429 path, which already falls back.
              // On fallback failure we LOG and return the (enhanced) error response
              // instead of throwing, so OpenCode surfaces actionable guidance and the
              // session/subagent continues.
              //
              // We deliberately do NOT fall back on other 403s: a generic 403 from the
              // backend is a permission/credential signal (expired token, IP/ACL/
              // verification denial), not "model unavailable". Falling back there would
              // silently mask a real account-access problem and shift the user onto
              // their API key unknowingly. The actionable 403 case (account
              // verification) is handled above.
              if (
                (response.status === 404 || permissionDeniedOnProject) &&
                isAgySdkSupportedRequest(urlString)
              ) {
                const fallbackModelLabel = extractRequestedGeminiModel(urlString) ?? model ?? family;
                const modelUnavailableFallback = await tryAgySdkFallbackForRequest(
                  input,
                  init,
                  config,
                  agySdkCredentials,
                  urlString,
                );
                if (modelUnavailableFallback) {
                  if (modelUnavailableFallback.ok) {
                    pushDebug(`agy-sdk fallback OK after Antigravity ${response.status} for ${fallbackModelLabel}`);
                    // Expected, healthy degradation — info, not warn.
                    log.info("agy-sdk fallback served model unavailable on Antigravity", {
                      antigravityStatus: response.status,
                      model: fallbackModelLabel,
                      account: account.email ?? account.index,
                    });
                    return modelUnavailableFallback;
                  }
                  pushDebug(
                    `agy-sdk fallback failed (${modelUnavailableFallback.status}) after Antigravity ${response.status} for ${fallbackModelLabel}`,
                  );
                  log.warn("agy-sdk fallback also failed for model unavailable on Antigravity", {
                    antigravityStatus: response.status,
                    fallbackStatus: modelUnavailableFallback.status,
                    model: fallbackModelLabel,
                  });
                  return modelUnavailableFallback;
                }
                // No api-key fallback available (disabled or no credentials): fall
                // through and return the Antigravity error below. It's still a Response,
                // not a throw, so OpenCode continues.
                pushDebug(
                  `no agy-sdk fallback available for ${fallbackModelLabel} after Antigravity ${response.status}`,
                );
              }

              // Success or non-retryable error - return the response
              if (response.ok) {
                account.consecutiveFailures = 0;
                getHealthTracker().recordSuccess(account.index);
                accountManager.markAccountUsed(account.index);
                
                void triggerAsyncQuotaRefreshForAccount(
                  accountManager,
                  account.index,
                  config.quota_refresh_interval_minutes,
                );
              }
              logAntigravityDebugResponse(debugContext, response, {
                note: response.ok ? "Success" : `Error ${response.status}`,
              });
              if (response.ok && !prepared.streaming) {
                await logResponseBody(debugContext, response, response.status);
              }
              if (!response.ok) {
                await logResponseBody(debugContext, response, response.status);
                
                // Handle 400 "Prompt too long" with synthetic response to avoid session lock
                if (response.status === 400) {
                  const cloned = response.clone();
                  const bodyText = await cloned.text();
                  if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
                    notify(
                      "Context too long - use /compact to reduce size",
                      "warning"
                    );
                    const errorMessage = `[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.\n\nAlternatively, you can:\n- Use /clear to start fresh\n- Use /undo to remove recent messages\n- Switch to a model with larger context window`;
                    return createSyntheticErrorResponse(errorMessage, prepared.requestedModel, family);
                  }
                }
              }
              
              // Empty response retry logic (ported from LLM-API-Key-Proxy)
              // For non-streaming responses, check if the response body is empty
              // and retry if so (up to config.empty_response_max_attempts times)
              if (response.ok && !prepared.streaming) {
                const maxAttempts = config.empty_response_max_attempts ?? 4;
                const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000;
                
                if (isEmptyResponseBody(bufferedBody ?? "")) {
                  emptyResponseAttempts += 1;
                  pushDebug(`empty-response: attempt ${emptyResponseAttempts}/${maxAttempts}`);

                  if (emptyResponseAttempts < maxAttempts) {
                    notify(
                      `Empty response received. Retrying (${emptyResponseAttempts}/${maxAttempts})...`,
                      "warning"
                    );
                    await sleep(retryDelayMs, abortSignal);
                    // Retry the SAME endpoint: the for-loop's i++ brings it back.
                    i -= 1;
                    continue;
                  }

                  throw new EmptyResponseError(
                    "antigravity",
                    prepared.effectiveModel ?? "unknown",
                    emptyResponseAttempts,
                  );
                }
              }
              
              const transformedResponse = await transformAntigravityResponse(
                response,
                prepared.streaming,
                debugContext,
                prepared.requestedModel,
                prepared.projectId,
                prepared.endpoint,
                prepared.effectiveModel,
                prepared.sessionId,
                prepared.toolDebugMissing,
                prepared.toolDebugSummary,
                prepared.toolDebugPayload,
                debugLines,
              );

              // Check for context errors and show appropriate toast
              const contextError = transformedResponse.headers.get("x-antigravity-context-error");
              if (contextError) {
                if (contextError === "prompt_too_long") {
                  notify(
                    "Context too long - use /compact to reduce size, or trim your request",
                    "warning"
                  );
                } else if (contextError === "tool_pairing") {
                  notify(
                    "Tool call/result mismatch - use /compact to fix, or /undo last message",
                    "warning"
                  );
                }
              }

              return transformedResponse;
            } catch (error) {
              // Refund token on network/API error (only if consumed)
              if (tokenConsumed) {
                getTokenTracker().refund(account.index);
                tokenConsumed = false;
              }

              // Handle recoverable thinking errors - retry with forced recovery
              if (error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
                // Only retry once with forced recovery to avoid infinite loops
                if (!forceThinkingRecovery) {
                  pushDebug("thinking-recovery: API error detected, retrying with forced recovery");
                  forceThinkingRecovery = true;
                  i = -1; // Will become 0 after loop increment, restart endpoint loop
                  continue;
                }
                
                // Already tried with forced recovery, give up and return error
                const recoveryError = error as any;
                const originalError = recoveryError.originalError || { error: { message: "Thinking recovery triggered" } };
                
                const recoveryMessage = `${originalError.error?.message || "Session recovery failed"}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`;
                
                return new Response(JSON.stringify({
                  type: "error",
                  error: {
                    type: "unrecoverable_error",
                    message: recoveryMessage
                  }
                }), {
                  status: 400,
                  headers: { "Content-Type": "application/json" }
                });
              }

              if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                lastError = error instanceof Error ? error : new Error(String(error));
                continue;
              }

              // All endpoints failed for this account - track failure and try next account
              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
              lastError = error instanceof Error ? error : new Error(String(error));
              if (shouldCooldown) {
                accountManager.markAccountCoolingDown(account, cooldownMs, "network-error");
                accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);
                pushDebug(`endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`);
              }
              shouldSwitchAccount = true;
              break;
            }
          }
          } // end headerStyleLoop
          
          if (shouldSwitchAccount) {
            // Exclude the account we're switching away from so the next
            // selection picks a DIFFERENT one (or returns null when none are
            // left). Without this, hybrid selection can re-pick the same
            // account and the loop spins forever (no fetch, 100% CPU).
            triedSwitchIndices.add(account.index);
            // Avoid tight retry loops when there's only one account.
            if (accountCount <= 1) {
              if (lastFailure) {
                return transformAntigravityResponse(
                  lastFailure.response,
                  lastFailure.streaming,
                  lastFailure.debugContext,
                  lastFailure.requestedModel,
                  lastFailure.projectId,
                  lastFailure.endpoint,
                  lastFailure.effectiveModel,
                  lastFailure.sessionId,
                  lastFailure.toolDebugMissing,
                  lastFailure.toolDebugSummary,
                  lastFailure.toolDebugPayload,
                  debugLines,
                );
              }

              throw lastError || new Error("All Antigravity endpoints failed");
            }

            continue;
          }

          // If we get here without returning, something went wrong
          if (lastFailure) {
            return transformAntigravityResponse(
              lastFailure.response,
              lastFailure.streaming,
              lastFailure.debugContext,
              lastFailure.requestedModel,
              lastFailure.projectId,
              lastFailure.endpoint,
              lastFailure.effectiveModel,
              lastFailure.sessionId,
              lastFailure.toolDebugMissing,
              lastFailure.toolDebugSummary,
              lastFailure.toolDebugPayload,
              debugLines,
            );
          }

          throw lastError || new Error("All Antigravity accounts failed");
        }
      },
    };
}

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value);
  try {
    const url = new URL(urlString);
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(":generateContent", ":streamGenerateContent");
    }
    url.searchParams.set("alt", "sse");
    return url.toString();
  } catch {
    return urlString;
  }
}

function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}

function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/\?]+)/);
  return match?.[1] ?? null;
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString);
  let family: ModelFamily = "gemini";
  if (model && model.includes("claude")) {
    family = "claude";
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family);
  }
  return family;
}

function resolveQuotaFallbackHeaderStyle(input: {
  family: ModelFamily;
  headerStyle: HeaderStyle;
  alternateStyle: HeaderStyle | null;
}): HeaderStyle | null {
  if (input.family !== "gemini") {
    return null;
  }
  if (!input.alternateStyle || input.alternateStyle === input.headerStyle) {
    return null;
  }
  return input.alternateStyle;
}

type HeaderRoutingDecision = {
  cliFirst: boolean;
  preferredHeaderStyle: HeaderStyle;
  explicitQuota: boolean;
  allowQuotaFallback: boolean;
};

function resolveHeaderRoutingDecision(
  urlString: string,
  family: ModelFamily,
  config: AntigravityConfig,
): HeaderRoutingDecision {
  const cliFirst = getCliFirst(config);
  const preferredHeaderStyle = getHeaderStyleFromUrl(urlString, family, cliFirst);
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  const resolvedModel = modelWithSuffix
    ? resolveModelWithTier(modelWithSuffix, { cli_first: cliFirst })
    : null;
  const explicitQuota = resolvedModel?.explicitQuota ?? false;
  return {
    cliFirst,
    preferredHeaderStyle,
    explicitQuota,
    allowQuotaFallback: family === "gemini",
  };
}

function getCliFirst(config: AntigravityConfig): boolean {
  return (config as AntigravityConfig & { cli_first?: boolean }).cli_first ?? false;
}

function getHeaderStyleFromUrl(
  urlString: string,
  family: ModelFamily,
  cliFirst: boolean = false,
): HeaderStyle {
  if (family === "claude") {
    return "antigravity";
  }
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  if (!modelWithSuffix) {
    return cliFirst ? "gemini-cli" : "antigravity";
  }
  const { quotaPreference } = resolveModelWithTier(modelWithSuffix, { cli_first: cliFirst });
  return quotaPreference ?? "antigravity";
}

export const __testExports = {
  getHeaderStyleFromUrl,
  createSoftQuotaBlockedResponse,
  tryFetchWithAgySdkCredentials,
  resolveHeaderRoutingDecision,
  resolveQuotaFallbackHeaderStyle,
};
