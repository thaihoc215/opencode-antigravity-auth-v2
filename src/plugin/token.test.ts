import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the new access token when the refresh token is unchanged", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth);

    expect(result?.access).toBe("new-access");
    expect(result?.refresh).toBe(baseAuth.refresh);
  });

  it("handles Google refresh token rotation", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth);

    expect(result?.access).toBe("next-access");
    expect(result?.refresh).toContain("rotated-token");
  });

  it("throws a typed error on invalid_grant", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
        { status: 400, statusText: "Bad Request" },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAccessToken(baseAuth)).rejects.toMatchObject({
      name: "AntigravityTokenRefreshError",
      code: "invalid_grant",
    });
  });

  it("shares one request between concurrent refreshes of the same token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ access_token: "shared-access", expires_in: 3600 }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = refreshAccessToken(baseAuth);
    const second = refreshAccessToken({ ...baseAuth, access: "other" });
    release();

    expect((await first)?.access).toBe("shared-access");
    expect((await second)?.access).toBe("shared-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later refresh asks Google again.
    await refreshAccessToken(baseAuth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the token request with a timeout", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAccessToken(baseAuth)).resolves.toBeUndefined();
  });
});
