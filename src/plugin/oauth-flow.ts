/**
 * Google sign-in pieces shared by the OpenCode integration (inside the
 * server) and the account manager CLI: where the browser can reach us, callback
 * parsing, and writing a sign-in to the account pool.
 */
import { readFileSync } from "node:fs";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  type AntigravityTokenExchangeResult,
  type OAuthCallbackParams,
} from "../antigravity/oauth";
import { parseRefreshParts } from "./auth";
import { createLogger } from "./logger";
import { startOAuthListener, type OAuthListener } from "./server";
import {
  hashRefreshToken,
  loadAccounts,
  replaceAccountPool,
  saveAccounts,
  saveAccountsReplace,
  type AccountStorageV4,
} from "./storage";
import type { OAuthAuthorizationResult } from "./types";

const log = createLogger("oauth-flow");

export type AntigravityTokenExchangeSuccess = Extract<AntigravityTokenExchangeResult, { type: "success" }>;

/** How long a sign-in waits for Google to redirect back to localhost. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function procVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase();
  } catch {
    return "";
  }
}

export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  const version = procVersion();
  return version.includes("microsoft") || version.includes("wsl");
}

function isWSL2(): boolean {
  if (!isWSL()) return false;
  const version = procVersion();
  return version.includes("wsl2") || version.includes("microsoft-standard");
}

function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL()) {
    return true;
  }
  return false;
}

/**
 * Whether the browser that completes sign-in probably cannot reach this
 * process's localhost (SSH, containers, WSL2, OPENCODE_HEADLESS). The user then
 * pastes the redirect URL instead.
 */
export function shouldUseManualOAuth(): boolean {
  return !!process.env.OPENCODE_HEADLESS || isWSL2() || isRemoteEnvironment();
}

/**
 * Reads what the user pasted after sign-in: the full redirect URL, or only the
 * code. A bare code is taken as belonging to `expectedState`; a URL keeps its
 * own `state`, which the token exchange checks.
 */
export function parseOAuthCallbackInput(
  value: string,
  expectedState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { code: trimmed, state: expectedState };
  }

  const denied = url.searchParams.get("error");
  if (denied) {
    return { error: `Google sign-in did not complete (${denied}).` };
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return { error: "Missing code in callback URL" };
  }
  return { code, state: url.searchParams.get("state") ?? expectedState };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Adds sign-ins to the pool, updating an existing account with the same email
 * or refresh token. With `replaceAll`, the sign-ins become the whole pool and
 * every other account is deleted ("start fresh").
 */
export async function persistAccountPool(
  results: AntigravityTokenExchangeSuccess[],
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const now = Date.now();
  const stored = replaceAll ? null : await loadAccounts();
  const accounts = stored?.accounts ? [...stored.accounts] : [];

  const indexByRefreshToken = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc?.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc?.email) {
      indexByEmail.set(acc.email, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    // Prefer the email match: Google usually issues a new refresh token on
    // every sign-in, so the token alone would add a duplicate.
    const existingByEmail = result.email ? indexByEmail.get(result.email) : undefined;
    const existingIndex = existingByEmail ?? indexByRefreshToken.get(parts.refreshToken);

    if (existingIndex === undefined) {
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (result.email) {
        indexByEmail.set(result.email, newIndex);
      }
      accounts.push({
        email: result.email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    };

    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
    }
  }

  if (accounts.length === 0) {
    return;
  }

  const activeIndex = replaceAll
    ? 0
    : (typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex) ? stored.activeIndex : 0);
  const clamped = clampInt(activeIndex, 0, accounts.length - 1);
  const storage: AccountStorageV4 = {
    version: 4,
    accounts,
    activeIndex: clamped,
    activeIndexByFamily: { claude: clamped, gemini: clamped },
  };

  if (replaceAll) {
    await replaceAccountPool(storage);
  } else {
    await saveAccounts(storage);
  }
}

/**
 * Replaces the stored account at `index` with a fresh sign-in, as the
 * "re-authenticate" action does. Rate-limit and verification state of the old
 * entry is dropped; `addedAt` and project ids are kept.
 *
 * Writes with `saveAccountsReplace`: `saveAccounts` merges by refresh token,
 * which would keep the old entry next to the new one (Google usually issues a
 * new token) or merge the old state back (when it does not). A replaced token
 * is tombstoned so a running plugin saving its in-memory pool cannot restore it.
 */
export async function replaceStoredAccount(index: number, result: AntigravityTokenExchangeSuccess): Promise<void> {
  const currentStorage = await loadAccounts();
  if (!currentStorage) {
    return;
  }
  const updatedAccounts = [...currentStorage.accounts];
  const parts = parseRefreshParts(result.refresh);
  if (!parts.refreshToken) {
    return;
  }
  const oldRefreshToken = updatedAccounts[index]?.refreshToken;
  updatedAccounts[index] = {
    email: result.email ?? updatedAccounts[index]?.email,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? updatedAccounts[index]?.projectId,
    managedProjectId: parts.managedProjectId ?? updatedAccounts[index]?.managedProjectId,
    addedAt: updatedAccounts[index]?.addedAt ?? Date.now(),
    lastUsed: Date.now(),
  };
  const tombstoneOldToken = oldRefreshToken !== undefined && oldRefreshToken !== parts.refreshToken;
  await saveAccountsReplace({
    version: 4,
    accounts: updatedAccounts,
    activeIndex: currentStorage.activeIndex,
    activeIndexByFamily: currentStorage.activeIndexByFamily,
    ...(tombstoneOldToken ? { deletedRefreshTokenHashes: [hashRefreshToken(oldRefreshToken)] } : {}),
  });
}

export interface BrowserOAuthOptions {
  /** Pre-selects this Google account on the consent screen (`login_hint`). */
  loginHint?: string;
  /**
   * Stores a successful sign-in. A rejection fails the sign-in with its
   * message. Defaults to adding the account to the pool (non-destructive).
   */
  persist?: (result: AntigravityTokenExchangeSuccess) => Promise<void>;
}

/**
 * Non-interactive sign-in for the OpenCode integration, which runs inside the
 * server. Nothing is opened here: OpenCode shows the URL (the TUI offers to
 * open it), possibly on another machine than the server.
 *
 * - "auto": a localhost listener receives Google's redirect. It only accepts
 *   the redirect carrying this sign-in's `state` and waits up to
 *   OAUTH_CALLBACK_TIMEOUT_MS.
 * - "code": used when the browser cannot reach this machine's localhost, or
 *   the callback port is taken (another sign-in in progress). The user pastes
 *   the redirect URL.
 *
 * The sign-in only succeeds once `persist` stored it, so OpenCode never keeps
 * a credential the pool does not have.
 */
export async function createBrowserOAuthAuthorization(
  options: BrowserOAuthOptions = {},
): Promise<OAuthAuthorizationResult> {
  const authorization = await authorizeAntigravity("", { loginHint: options.loginHint });
  const persist = options.persist ?? ((result: AntigravityTokenExchangeSuccess) => persistAccountPool([result]));

  const finish = async (callback: OAuthCallbackParams): Promise<AntigravityTokenExchangeResult> => {
    const result = await exchangeAntigravity(authorization, callback);
    if (result.type !== "success") {
      return result;
    }
    try {
      await persist(result);
    } catch (error) {
      return { type: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    return result;
  };

  let listener: OAuthListener | null = null;
  if (!shouldUseManualOAuth()) {
    try {
      listener = await startOAuthListener({
        expectedState: authorization.state,
        timeoutMs: OAUTH_CALLBACK_TIMEOUT_MS,
      });
    } catch (error) {
      log.warn("OAuth callback listener unavailable; using the paste flow", { error: String(error) });
    }
  }

  if (listener) {
    const activeListener = listener;
    return {
      url: authorization.url,
      instructions: "Open the URL and complete sign-in in your browser. The redirect back to localhost finishes it.",
      method: "auto",
      expiresAt: Date.now() + OAUTH_CALLBACK_TIMEOUT_MS,
      callback: async (): Promise<AntigravityTokenExchangeResult> => {
        try {
          const callbackUrl = await activeListener.waitForCallback();
          const params = parseOAuthCallbackInput(callbackUrl.toString(), authorization.state);
          if ("error" in params) {
            return { type: "failed", error: params.error };
          }
          return await finish(params);
        } catch (error) {
          return { type: "failed", error: error instanceof Error ? error.message : "Unknown error" };
        } finally {
          await activeListener.close().catch(() => {});
        }
      },
    };
  }

  return {
    url: authorization.url,
    instructions:
      "Open the URL, complete sign-in, then paste the full redirect URL from the address bar (or just the code).",
    method: "code",
    expiresAt: Date.now() + OAUTH_CALLBACK_TIMEOUT_MS,
    callback: async (codeInput: string): Promise<AntigravityTokenExchangeResult> => {
      const params = parseOAuthCallbackInput(codeInput, authorization.state);
      if ("error" in params) {
        return { type: "failed", error: params.error };
      }
      return finish(params);
    },
  };
}
