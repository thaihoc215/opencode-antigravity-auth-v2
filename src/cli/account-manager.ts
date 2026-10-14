/**
 * Interactive account manager, the menu behind `bunx opencode-antigravity-auth`:
 * add, re-authenticate, verify, enable/disable and delete pool accounts, and
 * check quotas.
 *
 * It edits antigravity-accounts.json directly. A running OpenCode server
 * applies enable/disable, verification and deletions on its next pool save,
 * and loads newly added accounts when it restarts.
 */
import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  authorizeAntigravity,
  exchangeAntigravity,
  type AntigravityAuthorization,
  type AntigravityTokenExchangeResult,
} from "../antigravity/oauth";
import {
  OAUTH_CALLBACK_TIMEOUT_MS,
  isWSL,
  parseOAuthCallbackInput,
  persistAccountPool,
  replaceStoredAccount,
  shouldUseManualOAuth,
  type AntigravityTokenExchangeSuccess,
} from "../plugin/oauth-flow";
import { checkAccountsQuota } from "../plugin/quota";
import { startOAuthListener, type OAuthListener } from "../plugin/server";
import {
  getStoragePath,
  loadAccounts,
  removeAccountFromStorage,
  removeAllAccountsFromStorage,
  saveAccounts,
  type AccountStorageV4,
} from "../plugin/storage";
import {
  clearStoredAccountVerificationRequired,
  markStoredAccountVerificationRequired,
  verifyAccountAccess,
} from "../plugin/verification";
import { assertSameAccount, resolveReauthIndex } from "../v2/actions";
import {
  pressEnterToContinue,
  promptAddAnotherAccount,
  promptLoginMode,
  promptProjectId,
  type ExistingAccountInfo,
} from "./prompts";

const MAX_OAUTH_ACCOUNTS = 10;

/** How long to wait for the browser redirect before offering to paste it instead. */
const CALLBACK_SOFT_TIMEOUT_MS = 120_000;

const SIGN_IN_HINT = "opencode auth login google --method antigravity";

export interface AccountManagerOptions {
  /** Do not open a browser or listen on localhost; paste the redirect URL instead. */
  noBrowser?: boolean;
}

async function promptLine(message: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function openBrowser(url: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (isWSL()) {
      try {
        exec(`wslview "${url}"`);
        return true;
      } catch {}
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
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

// =============================================================================
// Sign-in
// =============================================================================

async function promptManualOAuthInput(authorization: AntigravityAuthorization): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const input = await promptLine("Paste the redirect URL (or just the code) here: ");
  const params = parseOAuthCallbackInput(input, authorization.state);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }
  return exchangeAntigravity(authorization, params);
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms).unref?.();
  });
}

async function signIn(
  projectId: string,
  loginHint: string | undefined,
  manual: boolean,
): Promise<AntigravityTokenExchangeResult> {
  const authorization = await authorizeAntigravity(projectId, { loginHint });
  console.log("\nOAuth URL:\n" + authorization.url + "\n");

  if (manual) {
    if (!(await openBrowser(authorization.url))) {
      console.log("Could not open browser automatically.");
      console.log("Please open the URL above manually in your local browser.\n");
    }
    return promptManualOAuthInput(authorization);
  }

  let listener: OAuthListener | null = null;
  try {
    listener = await startOAuthListener({
      expectedState: authorization.state,
      timeoutMs: OAUTH_CALLBACK_TIMEOUT_MS,
    });
  } catch (error) {
    console.log(`Cannot receive the redirect on localhost (${error instanceof Error ? error.message : String(error)}).`);
  }
  await openBrowser(authorization.url);
  if (!listener) {
    return promptManualOAuthInput(authorization);
  }

  try {
    const callbackUrl = await Promise.race([listener.waitForCallback(), delay(CALLBACK_SOFT_TIMEOUT_MS)]);
    if (!callbackUrl) {
      console.log(`\n⏳ No redirect received after ${formatWaitTime(CALLBACK_SOFT_TIMEOUT_MS)}.`);
      console.log("You can paste the redirect URL manually.\n");
      console.log("OAuth URL (in case you need it again):");
      console.log(authorization.url + "\n");
      await listener.close().catch(() => {});
      return promptManualOAuthInput(authorization);
    }
    const params = parseOAuthCallbackInput(callbackUrl.toString(), authorization.state);
    if ("error" in params) {
      return { type: "failed", error: params.error };
    }
    return await exchangeAntigravity(authorization, params);
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    await listener.close().catch(() => {});
  }
}

/**
 * Re-authenticate: write the sign-in over the selected account. The pool may
 * have changed since the menu was shown, so the account is found again by
 * email, and a sign-in as a different Google account is refused.
 */
async function reauthenticate(
  target: { index: number; email?: string },
  result: AntigravityTokenExchangeSuccess,
): Promise<void> {
  const accounts = (await loadAccounts())?.accounts ?? [];
  const index = resolveReauthIndex(accounts, { type: "reauth", ...target });
  if (index === undefined) {
    throw new Error(`${target.email ?? `Account ${target.index + 1}`} is no longer in the account pool. Nothing was changed.`);
  }
  assertSameAccount(accounts[index]?.email, result.email);
  await replaceStoredAccount(index, result);
}

// =============================================================================
// Menu actions
// =============================================================================

function menuAccounts(storage: AccountStorageV4): ExistingAccountInfo[] {
  const now = Date.now();
  return storage.accounts.map((acc, idx) => {
    let status: ExistingAccountInfo["status"] = "active";
    if (acc.verificationRequired) {
      status = "verification-required";
    } else {
      const rateLimited = Object.values(acc.rateLimitResetTimes ?? {}).some(
        (resetTime) => typeof resetTime === "number" && resetTime > now,
      );
      if (rateLimited || (acc.coolingDownUntil && acc.coolingDownUntil > now)) {
        status = "rate-limited";
      }
    }
    return {
      email: acc.email,
      index: idx,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      status,
      isCurrentAccount: idx === (storage.activeIndex ?? 0),
      enabled: acc.enabled !== false,
    };
  });
}

async function showQuotas(storage: AccountStorageV4): Promise<void> {
  console.log("\n📊 Checking quotas for all accounts...\n");
  const results = await checkAccountsQuota(storage.accounts);
  let storageUpdated = false;

  const colors = {
    red: "\x1b[31m",
    orange: "\x1b[33m",
    green: "\x1b[32m",
    reset: "\x1b[0m",
  };
  const getColor = (remaining?: number): string => {
    if (typeof remaining !== "number") return colors.reset;
    if (remaining < 0.2) return colors.red;
    if (remaining < 0.6) return colors.orange;
    return colors.green;
  };
  const createProgressBar = (remaining?: number, width: number = 20): string => {
    if (typeof remaining !== "number") return "░".repeat(width) + " n/a";
    const filled = Math.round(remaining * width);
    const empty = width - filled;
    const color = getColor(remaining);
    const bar = `${color}${"█".repeat(filled)}${colors.reset}${"░".repeat(empty)}`;
    const pct = `${color}${Math.round(remaining * 100)}%${colors.reset}`.padStart(4 + color.length + colors.reset.length);
    return `${bar} ${pct}`;
  };
  const formatReset = (resetTime?: string): string => {
    if (!resetTime) return "";
    const ms = Date.parse(resetTime) - Date.now();
    if (ms <= 0) return " (resetting...)";
    const hours = ms / (1000 * 60 * 60);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainingHours = Math.floor(hours % 24);
      return remainingHours > 0 ? ` (resets in ${days}d ${remainingHours}h)` : ` (resets in ${days}d)`;
    }
    return ` (resets in ${formatWaitTime(ms)})`;
  };

  for (const res of results) {
    const label = res.email || `Account ${res.index + 1}`;
    const disabledStr = res.disabled ? " (disabled)" : "";
    console.log("━".repeat(60));
    console.log(`  ${label}${disabledStr}`);
    console.log("━".repeat(60));

    if (res.status === "error") {
      console.log(`  ❌ Error: ${res.error}\n`);
      continue;
    }

    const hasGeminiCli = res.geminiCliQuota && res.geminiCliQuota.models.length > 0;
    console.log(`\n  ┌─ Gemini CLI Quota`);
    if (!hasGeminiCli) {
      console.log(`  │  └─ ${res.geminiCliQuota?.error || "No Gemini CLI quota available"}`);
    } else {
      const models = res.geminiCliQuota!.models;
      models.forEach((model, idx) => {
        const connector = idx === models.length - 1 ? "└─" : "├─";
        console.log(`  │  ${connector} ${model.modelId.padEnd(29)} ${createProgressBar(model.remainingFraction)}${formatReset(model.resetTime)}`);
      });
    }

    const hasAntigravity = res.quota && Object.keys(res.quota.groups).length > 0;
    console.log(`  │`);
    console.log(`  └─ Antigravity Quota`);
    if (!hasAntigravity) {
      console.log(`     └─ ${res.quota?.error || "No quota information available"}`);
    } else {
      const groups = res.quota!.groups;
      // Antigravity meters Gemini quota per family (one shared Pro bucket,
      // one shared Flash bucket), not per model version.
      const groupEntries = [
        { name: "Claude", data: groups.claude },
        { name: "Gemini Pro", data: groups["gemini-pro"] },
        { name: "Gemini Flash", data: groups["gemini-flash"] },
      ].filter((g) => g.data);
      groupEntries.forEach((g, idx) => {
        const connector = idx === groupEntries.length - 1 ? "└─" : "├─";
        // No numeric fraction from the backend renders "n/a", not 0%.
        const fraction = g.data!.remainingFractionReported ? g.data!.remainingFraction : undefined;
        console.log(`     ${connector} ${g.name.padEnd(29)} ${createProgressBar(fraction)}${formatReset(g.data!.resetTime)}`);
      });
    }
    console.log("");

    // Cache quota data for soft quota protection
    const acc = storage.accounts[res.index];
    if (res.updatedAccount) {
      storage.accounts[res.index] = {
        ...res.updatedAccount,
        cachedQuota: res.quota?.groups,
        cachedQuotaUpdatedAt: Date.now(),
      };
      storageUpdated = true;
    } else if (acc && res.quota?.groups) {
      acc.cachedQuota = res.quota.groups;
      acc.cachedQuotaUpdatedAt = Date.now();
      storageUpdated = true;
    }
  }
  if (storageUpdated) {
    await saveAccounts(storage);
  }
  console.log("");
  await pressEnterToContinue();
}

async function toggleAccount(storage: AccountStorageV4, index: number): Promise<void> {
  const acc = storage.accounts[index];
  if (!acc) return;
  acc.enabled = acc.enabled === false;
  acc.statusChangedAt = Date.now();
  await saveAccounts(storage);
  console.log(`\nAccount ${acc.email || index + 1} ${acc.enabled ? "enabled" : "disabled"}.\n`);
  await pressEnterToContinue();
}

async function verifyAll(storage: AccountStorageV4): Promise<void> {
  console.log(`\nChecking verification status for ${storage.accounts.length} account(s)...\n`);

  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  let storageUpdated = false;
  const blockedResults: Array<{ label: string; message: string; verifyUrl?: string }> = [];

  for (let i = 0; i < storage.accounts.length; i++) {
    const account = storage.accounts[i];
    if (!account) continue;

    const label = account.email || `Account ${i + 1}`;
    process.stdout.write(`- [${i + 1}/${storage.accounts.length}] ${label} ... `);

    const verification = await verifyAccountAccess(account);
    if (verification.status === "ok") {
      storageUpdated = clearStoredAccountVerificationRequired(account, true).changed || storageUpdated;
      okCount += 1;
      console.log("ok");
      continue;
    }

    if (verification.status === "blocked") {
      storageUpdated = markStoredAccountVerificationRequired(account, verification.message, verification.verifyUrl) || storageUpdated;
      blockedCount += 1;
      console.log("needs verification");
      blockedResults.push({
        label,
        message: verification.message,
        verifyUrl: verification.verifyUrl ?? account.verificationUrl,
      });
      continue;
    }

    errorCount += 1;
    console.log(`error (${verification.message})`);
  }

  if (storageUpdated) {
    await saveAccounts(storage);
  }

  console.log(`\nVerification summary: ${okCount} ready, ${blockedCount} need verification, ${errorCount} errors.`);
  if (blockedResults.length > 0) {
    console.log("\nAccounts needing verification:");
    for (const result of blockedResults) {
      console.log(`\n- ${result.label}`);
      console.log(`  ${result.message}`);
      console.log(`  URL: ${result.verifyUrl ?? "not provided by API response"}`);
    }
  }
  console.log("");
  await pressEnterToContinue();
}

async function promptAccountIndexForVerification(accounts: ExistingAccountInfo[]): Promise<number | undefined> {
  console.log("\nSelect an account to verify:");
  for (const account of accounts) {
    console.log(`  ${account.index + 1}. ${account.email || `Account ${account.index + 1}`}`);
  }
  console.log("");

  while (true) {
    const answer = await promptLine("Account number (leave blank to cancel): ");
    if (!answer) {
      return undefined;
    }
    const parsedIndex = Number(answer);
    if (!Number.isInteger(parsedIndex)) {
      console.log("Please enter a valid account number.");
      continue;
    }
    const selected = accounts.find((account) => account.index === parsedIndex - 1);
    if (!selected) {
      console.log("Please enter a number from the list above.");
      continue;
    }
    return selected.index;
  }
}

async function verifyOne(storage: AccountStorageV4, index: number | undefined): Promise<void> {
  const verifyIndex = index ?? await promptAccountIndexForVerification(menuAccounts(storage));
  if (verifyIndex === undefined) {
    console.log("\nVerification cancelled.\n");
    await pressEnterToContinue();
    return;
  }

  const account = storage.accounts[verifyIndex];
  if (!account) {
    console.log(`\nAccount ${verifyIndex + 1} not found.\n`);
    await pressEnterToContinue();
    return;
  }

  const label = account.email || `Account ${verifyIndex + 1}`;
  console.log(`\nChecking verification status for ${label}...\n`);
  const verification = await verifyAccountAccess(account);

  if (verification.status === "ok") {
    const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);
    if (changed) {
      await saveAccounts(storage);
    }
    console.log(wasVerificationRequired
      ? `✓ ${label} is ready for requests and has been re-enabled.\n`
      : `✓ ${label} is ready for requests.\n`);
    await pressEnterToContinue();
    return;
  }

  if (verification.status === "blocked") {
    if (markStoredAccountVerificationRequired(account, verification.message, verification.verifyUrl)) {
      await saveAccounts(storage);
    }
    const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
    console.log(`⚠ ${label} needs Google verification before it can be used.`);
    if (verification.message) {
      console.log(verification.message);
    }
    console.log(`${label} has been disabled until verification is completed.`);
    if (verifyUrl) {
      console.log(`\nVerification URL:\n${verifyUrl}\n`);
      const answer = (await promptLine("Open verification URL in your browser now? [Y/n]: ")).toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        console.log((await openBrowser(verifyUrl))
          ? "Opened verification URL in your browser.\n"
          : "Could not open browser automatically. Please open the URL manually.\n");
      }
    } else {
      console.log("No verification URL was returned. Try re-authenticating this account.\n");
    }
    await pressEnterToContinue();
    return;
  }

  console.log(`✗ ${label}: ${verification.message}\n`);
  await pressEnterToContinue();
}

// =============================================================================
// Entry point
// =============================================================================

type SignInPlan =
  | { type: "add"; replacePool: boolean }
  | { type: "reauth"; index: number; email?: string };

/**
 * Shows the menu until the user picks something that ends it (sign in,
 * delete, cancel). Returns the sign-in to run, or an exit code.
 */
async function runMenu(): Promise<SignInPlan | number> {
  while (true) {
    const storage = await loadAccounts();
    if (!storage || storage.accounts.length === 0) {
      return { type: "add", replacePool: false };
    }

    const menu = await promptLoginMode(menuAccounts(storage));
    switch (menu.mode) {
      case "check":
        await showQuotas(storage);
        continue;
      case "manage":
        if (menu.toggleAccountIndex !== undefined) {
          await toggleAccount(storage, menu.toggleAccountIndex);
        }
        continue;
      case "verify":
      case "verify-all":
        if (menu.mode === "verify-all" || menu.verifyAll) {
          await verifyAll(storage);
        } else {
          await verifyOne(storage, menu.verifyAccountIndex);
        }
        continue;
      case "cancel":
        return 0;
    }

    if (menu.deleteAccountIndex !== undefined) {
      const deleted = storage.accounts[menu.deleteAccountIndex];
      if (deleted) {
        await removeAccountFromStorage(deleted.refreshToken);
        console.log(`\nDeleted ${deleted.email ?? `account ${menu.deleteAccountIndex + 1}`}.\n`);
      }
      continue;
    }

    if (menu.deleteAll) {
      await removeAllAccountsFromStorage();
      console.log("\nAll accounts deleted.");
      console.log(`To add accounts, run this again or: ${SIGN_IN_HINT}\n`);
      return 0;
    }

    if (menu.refreshAccountIndex !== undefined) {
      const email = storage.accounts[menu.refreshAccountIndex]?.email;
      console.log(`\nRe-authenticating ${email || "account"}...\n`);
      return { type: "reauth", index: menu.refreshAccountIndex, ...(email ? { email } : {}) };
    }

    if (menu.mode === "fresh") {
      console.log("\nStarting fresh - existing accounts will be replaced.\n");
      return { type: "add", replacePool: true };
    }
    console.log("\nAdding to existing accounts.\n");
    return { type: "add", replacePool: false };
  }
}

/** Runs the account manager. Returns the process exit code. */
export async function runAccountManager(options: AccountManagerOptions = {}): Promise<number> {
  const manual = options.noBrowser === true || shouldUseManualOAuth();
  console.log(`Account pool: ${getStoragePath()}`);

  const plan = await runMenu();
  if (typeof plan === "number") {
    return plan;
  }

  let added = 0;
  while (added < MAX_OAUTH_ACCOUNTS) {
    console.log(`\n=== Antigravity OAuth (Account ${added + 1}) ===`);
    const projectId = await promptProjectId();
    const loginHint = plan.type === "reauth" ? plan.email : undefined;
    const result = await signIn(projectId, loginHint, manual);

    if (result.type === "failed") {
      if (added === 0) {
        console.error(`Authentication failed: ${result.error}`);
        return 1;
      }
      console.warn(`Skipping failed account ${added + 1}: ${result.error}`);
      break;
    }

    try {
      if (plan.type === "reauth") {
        await reauthenticate(plan, result);
      } else {
        await persistAccountPool([result], plan.replacePool && added === 0);
      }
    } catch (error) {
      console.error(`Could not save the account: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    added += 1;
    console.log(`Account ${added} authenticated${result.email ? ` (${result.email})` : ""}.`);

    if (plan.type === "reauth") {
      console.log("Token refreshed successfully.");
      return 0;
    }
    if (added >= MAX_OAUTH_ACCOUNTS) {
      break;
    }

    const currentCount = (await loadAccounts())?.accounts.length ?? added;
    if (!(await promptAddAnotherAccount(currentCount))) {
      break;
    }
  }

  const total = (await loadAccounts())?.accounts.length ?? added;
  console.log(`Multi-account setup complete (${total} account(s)).`);
  return 0;
}
