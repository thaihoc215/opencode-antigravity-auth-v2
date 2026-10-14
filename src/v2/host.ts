import type { Plugin } from "@opencode/plugin";
import { createLogger } from "../plugin/logger";
import type { AuthDetails, PluginClient } from "../plugin/types";

const log = createLogger("v2.host");

/**
 * Implements the core's host client on top of the V2 plugin context.
 *
 * - Toasts: V2 server plugins have no TUI access (that needs a separate CLI
 *   plugin), so toasts are written to the plugin log instead.
 * - `auth.set`: the core only calls it to store or clear the OpenCode-side
 *   OAuth credential. V2 plugins cannot write credentials; the account pool on
 *   disk stays the source of truth, so a clear becomes a "needs sign-in"
 *   connection status and a store is a no-op.
 */
export function createV2Client(ctx: Plugin.Context, integrationID: string): PluginClient {
  return {
    tui: {
      async showToast({ body }) {
        const prefix = body.title ? `${body.title}: ` : "";
        log.info(`[${body.variant}] ${prefix}${body.message}`);
      },
    },
    auth: {
      async set({ body }) {
        if (body.refresh) return;
        const connection = await ctx.integration.connection.active(integrationID);
        if (!connection) return;
        await ctx.integration.connection.status({
          integrationID,
          connection,
          status: {
            status: "needs_auth",
            message: "Google revoked the stored Antigravity refresh tokens. Sign in again.",
          },
        });
      },
    },
  };
}

/**
 * Reads the active credential of an integration and converts it to the auth
 * shape the core's loader expects (the V1 `getAuth()` contract).
 */
export function createV2GetAuth(ctx: Plugin.Context, integrationID: string): () => Promise<AuthDetails> {
  return async () => {
    const connection = await ctx.integration.connection.active(integrationID);
    if (!connection) return { type: "none" };
    const credential = await ctx.integration.connection.resolve(connection);
    if (!credential) return { type: "none" };
    if (credential.type === "oauth") {
      return {
        type: "oauth",
        refresh: credential.refresh,
        access: credential.access,
        expires: credential.expires,
      };
    }
    if (credential.type === "key") {
      return { type: "api", key: credential.key };
    }
    return { type: credential.type };
  };
}
