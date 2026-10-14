import type { Plugin } from "@opencode/plugin";
import type { AuthDetails } from "../plugin/types";

/**
 * Reads the active credential of an integration and converts it to the auth
 * shape the core expects.
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

/**
 * Marks the active connection as needing a new sign-in. The core calls it when
 * Google revoked the refresh token of every pool account; V2 plugins cannot
 * write credentials, and the account pool on disk stays the source of truth.
 */
export function createV2RevokedReporter(ctx: Plugin.Context, integrationID: string): () => Promise<void> {
  return async () => {
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
  };
}
