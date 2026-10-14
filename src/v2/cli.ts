#!/usr/bin/env bun
/**
 * Interactive Antigravity account manager.
 *
 * OpenCode V2 runs plugins inside its server, where an integration's OAuth
 * method cannot drive a terminal menu. This CLI runs the core's interactive
 * login flow (add, re-authenticate, enable/disable, delete accounts, check
 * quotas) against the same account pool file the plugin reads.
 *
 * Usage: bunx opencode-antigravity-auth [--no-browser] (see HELP below)
 */
import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { createAntigravityPlugin } from "../plugin";
import type { PluginClient } from "../plugin/types";

const consoleClient: PluginClient = {
  tui: {
    async showToast({ body }) {
      console.log(body.title ? `${body.title}: ${body.message}` : body.message);
    },
  },
  // The account pool on disk is the source of truth; there is no OpenCode
  // credential store to update from a standalone process.
  auth: { async set() {} },
};

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
  opencode service restart       The server reads the pool at startup

Full logout:
  1. Delete all accounts here
  2. opencode auth logout        Otherwise OpenCode's stored credential re-seeds the pool

Adding or re-authenticating accounts also works without this CLI:
  opencode auth login google --method antigravity
`;

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const core = await createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID)({
    client: consoleClient,
    directory: process.cwd(),
  });
  const noBrowser = process.argv.includes("--no-browser");
  const authorization = await core.auth.login(noBrowser ? { noBrowser: "true" } : {});
  if (authorization.method !== "auto") {
    console.error("Unexpected authorization mode.");
    return 1;
  }
  const result = await authorization.callback();
  if (authorization.instructions) {
    console.log(`\n${authorization.instructions}`);
  }
  if (result.type === "failed") {
    console.error(result.error);
    return 1;
  }
  console.log("Restart OpenCode (or its background service) to load account changes.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
