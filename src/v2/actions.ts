/**
 * The "Action" question shown by `opencode auth login` before the browser opens.
 *
 * V2 plugins run inside the OpenCode server and cannot draw a terminal menu, so
 * the login-related choices of the 1.x menu are offered as a form field instead.
 * Everything a form cannot express (deleting, enabling/disabling, quotas) stays
 * in the account manager CLI, which the field's description points to.
 */

export const ACTION_KEY = "action";
export const ADD_ACTION = "add";
const REAUTH_PREFIX = "reauth:";

/** What the form shows about one pool account. */
export interface PoolAccountSummary {
  index: number;
  email?: string;
  enabled: boolean;
  verificationRequired: boolean;
}

export type LoginAction = { type: "add" } | { type: "reauth"; index: number; email?: string };

/** The fields of a stored pool account this module reads. */
interface StoredAccountLike {
  email?: string;
  enabled?: boolean;
  verificationRequired?: boolean;
}

export function summarizeAccounts(accounts: readonly StoredAccountLike[]): PoolAccountSummary[] {
  return accounts.map((account, index) => ({
    index,
    email: account.email,
    enabled: account.enabled !== false,
    verificationRequired: account.verificationRequired === true,
  }));
}

function accountLabel(account: { index: number; email?: string }): string {
  return account.email ?? `account ${account.index + 1}`;
}

/** Builds the V2 form field (a string field with options). */
export function buildActionField(accounts: readonly PoolAccountSummary[], cliCommand: string) {
  const options = [
    {
      value: ADD_ACTION,
      label: "Add a new account",
      description:
        accounts.length === 0
          ? "No accounts yet"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} in the pool`,
    },
    ...accounts.map((account) => ({
      value: `${REAUTH_PREFIX}${account.index}`,
      label: `Re-authenticate ${accountLabel(account)}`,
      description: [
        `Account ${account.index + 1}`,
        ...(account.enabled ? [] : ["disabled"]),
        ...(account.verificationRequired ? ["verification required"] : []),
      ].join(" · "),
    })),
  ];
  return {
    key: ACTION_KEY,
    type: "string" as const,
    title: "Action",
    description:
      "Add a Google account to the Antigravity pool, or sign an existing one in again. " +
      `To delete accounts, enable/disable them or check quotas, run: ${cliCommand}`,
    required: true,
    default: ADD_ACTION,
    options,
  };
}

/** Maps a form answer back to the account it was built from. */
export function parseLoginAction(
  answer: Readonly<Record<string, unknown>>,
  accounts: readonly PoolAccountSummary[],
): LoginAction {
  const value = answer[ACTION_KEY] ?? ADD_ACTION;
  if (value === ADD_ACTION) {
    return { type: "add" };
  }
  if (typeof value === "string" && value.startsWith(REAUTH_PREFIX)) {
    const index = Number(value.slice(REAUTH_PREFIX.length));
    const account = accounts.find((entry) => entry.index === index);
    if (account) {
      return { type: "reauth", index, ...(account.email ? { email: account.email } : {}) };
    }
  }
  throw new Error(`Unknown action: ${String(value)}`);
}

/**
 * Locates the selected account in the current pool. Email is authoritative
 * because the pool can change between showing the form and finishing sign-in;
 * accounts without an email fall back to their index.
 */
export function resolveReauthIndex(
  accounts: readonly StoredAccountLike[],
  action: Extract<LoginAction, { type: "reauth" }>,
): number | undefined {
  if (action.email) {
    const wanted = action.email.toLowerCase();
    const index = accounts.findIndex((account) => account.email?.toLowerCase() === wanted);
    return index === -1 ? undefined : index;
  }
  return action.index < accounts.length ? action.index : undefined;
}

/** Re-authenticating must not silently swap one Google account for another. */
export function assertSameAccount(expected: string | undefined, signedIn: string | undefined): void {
  if (expected && signedIn && expected.toLowerCase() !== signedIn.toLowerCase()) {
    throw new Error(`Signed in as ${signedIn}, but ${expected} was selected. Nothing was changed.`);
  }
}
