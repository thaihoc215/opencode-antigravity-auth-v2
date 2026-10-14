#!/usr/bin/env bun
/**
 * Interactive Antigravity account manager.
 *
 * OpenCode V2 runs plugins inside its server, where an integration's OAuth
 * method cannot drive a terminal menu. This CLI (src/cli/account-manager.ts)
 * manages the same account pool file the plugin reads: add, re-authenticate,
 * enable/disable, delete accounts, check quotas.
 *
 * Usage: bunx opencode-antigravity-auth [--no-browser] (see HELP below)
 */
import { runAccountManager } from "../cli/account-manager";

const HELP = `Antigravity account manager

Usage:
  bunx opencode-antigravity-auth [--no-browser]
  bun <plugin directory>/src/v2/cli.ts [--no-browser]    (local checkout)

Options:
  --no-browser   Do not open a browser or listen on localhost; paste the redirect URL instead
  -h, --help     Show this help

Menu (use the arrow keys and Enter):
  Add account                    Sign in another Google account and add it to the pool;
                                 afterwards you can add more in a row
  Check quotas                   Show the remaining quota of every account
  Verify one / all accounts      Check that accounts still have access
  Register plugin in opencode.json
                                 Write the OpenCode V2 "plugins" entry
  <an account>                   Open the account, then:
    Verify account access
    Enable / Disable account     Keep it in the pool but skip it during rotation
    Refresh token                Sign that account in again
    Delete this account
  Delete all accounts            Remove the whole pool

After changes:
  A running OpenCode server applies enable/disable, verification and deletions
  on its next save of the pool. New accounts load when it restarts:
  opencode service restart

Full logout:
  1. Delete all accounts here
  2. opencode auth logout        Removes OpenCode's stored credential

Adding or re-authenticating accounts also works without this CLI:
  opencode auth login google --method antigravity
`;

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  return runAccountManager({ noBrowser: process.argv.includes("--no-browser") });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
