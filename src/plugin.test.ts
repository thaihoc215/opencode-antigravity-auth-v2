import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GetAuth } from "./plugin/types";
import { AccountManager } from "./plugin/accounts";

// Mock storage so disk reads/writes are isolated from real config files.
// Per-test we override `loadAccounts` to simulate "OAuth accounts on disk".
vi.mock("./plugin/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugin/storage")>();
  return {
    ...original,
    loadAccounts: vi.fn(async () => null),
    saveAccounts: vi.fn(async () => undefined),
    saveAccountsReplace: vi.fn(async () => undefined),
    removeAccountFromStorage: vi.fn(async () => undefined),
    removeAllAccountsFromStorage: vi.fn(async () => undefined),
  };
});

const { createAntigravityCore, loopEscapeTestHooks } = await import("./plugin");
const storageModule = await import("./plugin/storage");
const { resetPublicGeminiApiModelCatalogForTests } = await import("./plugin/model-catalog");
const { resetAgySdkCredentialStateForTests } = await import("./plugin/api-key");

/** Routes and cores built by a test; disposed after it so no background save outlives the test. */
const disposables: Array<{ dispose(): Promise<void> }> = [];

/** Builds the core with `getAuth` as the host's credential and loads its route. */
async function loadRoute(
  getAuth: GetAuth,
  onAccountsRevoked?: () => Promise<void>,
  options?: Record<string, unknown>,
) {
  const core = await createAntigravityCore({ directory: process.cwd(), getAuth, onAccountsRevoked, options });
  const route = await core.loader();
  disposables.push(...(route ? [route] : []), core);
  return route;
}

afterEach(async () => {
  for (const item of disposables.splice(0).reverse()) {
    await item.dispose();
  }
});

// models() discovery (exercised by some tests below) populates the
// module-level live model catalog as a side effect. Reset it after every test
// so one test's (possibly sparse, mock-driven) discovery fetch can't leak
// into another test's agy-sdk routing assertions.
afterEach(() => {
  resetPublicGeminiApiModelCatalogForTests();
});

describe("createAntigravityCore models", () => {
  it("merges discovered models into the static definitions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com/v1beta/models")) {
        return new Response(JSON.stringify({
          models: [
            {
              name: "models/gemini-driver",
              displayName: "Gemini Driver",
              inputTokenLimit: 123,
              outputTokenLimit: 45,
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }));
      }
      return new Response("1.2.3");
    }));

    try {
      const core = await createAntigravityCore({
        directory: process.cwd(),
        getAuth: async () => ({ type: "api", key: "secret" }),
      });

      const models = await core.models();

      expect(models["gemini-driver"]).toMatchObject({
        name: "Gemini Driver (Gemini API)",
        limit: { context: 123, output: 45 },
      });
      expect(models["antigravity-gemini-3.1-pro"]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes Gemini API-key auth without an OAuth account", async () => {
    const loader = await loadRoute(async () => ({ type: "api", key: "secret" }));

    expect(loader?.fetch).toBeTypeOf("function");
  });
});

describe("createAntigravityCore loader disk OAuth promotion", () => {
  beforeEach(() => {
    vi.mocked(storageModule.loadAccounts).mockReset();
    vi.mocked(storageModule.saveAccountsReplace).mockReset();
    vi.mocked(storageModule.removeAccountFromStorage).mockReset();
  });

  it("routes through the OAuth path when OpenCode reports API-key auth but OAuth accounts exist on disk", async () => {
    // Simulate ~/.config/opencode/antigravity-accounts.json holding a usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "fake-refresh-token",
          projectId: "fake-project",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    // Mock global fetch:
    //   - version check / model discovery → safe defaults
    //   - oauth2.googleapis.com (token refresh) → invalid_grant so the OAuth
    //     loop exits fast (account removed, no infinite retry)
    //   - anything else → 500 (won't be reached on the happy assertion path)
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "test-stop" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {

      const loader = await loadRoute(
        async () => ({ type: "api", key: "secret" }),
      );

      expect(loader).toHaveProperty("fetch");

      // Before the fix: this URL took the API-key-only branch and returned a
      // synthetic 404 with the "API-key path forwarded" guidance (no fetch made).
      // After the fix: disk OAuth is promoted, the OAuth path is taken, and the
      // first thing it does is refresh the access token against oauth2.googleapis.com.
      let responseBody = "";
      try {
        const response = await (loader as { fetch: typeof fetch }).fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
          { method: "POST", body: "{}" },
        );
        responseBody = await response.text();
      } catch {
        // OAuth path may throw after the invalid_grant exhausts the only account.
        // That's the expected failure mode for this test setup.
      }

      // Hard proof we took the OAuth path: a token-refresh request was issued.
      const tokenRefreshCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      );
      expect(tokenRefreshCalls.length).toBeGreaterThan(0);

      // Negative assertion: we did NOT short-circuit through the API-key-only
      // synthetic 404. That synthetic message is unique to the api-key path.
      expect(responseBody).not.toContain("API-key path forwarded the request");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps API-key-only behavior when disk has no OAuth accounts", async () => {
    // No accounts on disk — must NOT promote, must short-circuit Antigravity-only
    // models with the synthetic 404 guidance.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue(null);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    }));

    try {

      const loader = await loadRoute(
        async () => ({ type: "api", key: "secret" }),
      );

      const response = await (loader as { fetch: typeof fetch }).fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-sonnet-4-6:generateContent",
        { method: "POST", body: "{}" },
      );
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).toContain("API-key path forwarded the request");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never deletes the account pool when no OAuth account is available", async () => {
    // loadAccounts() also returns null for an unreadable file (a typo from a
    // hand edit, a lock): the loader must not treat that as "clear the pool".
    delete process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.mocked(storageModule.loadAccounts).mockResolvedValue(null);
    vi.mocked(storageModule.removeAllAccountsFromStorage).mockClear();
    vi.mocked(storageModule.removeAccountFromStorage).mockClear();

    const loader = await loadRoute(async () => ({ type: "none" }));

    expect(loader).toBeUndefined();
    expect(storageModule.removeAllAccountsFromStorage).not.toHaveBeenCalled();
    expect(storageModule.removeAccountFromStorage).not.toHaveBeenCalled();
  });

  it("uses Gemini CLI when Antigravity soft quota is exhausted", async () => {
    const now = Date.now();
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "refresh-token",
          projectId: "project-id",
          managedProjectId: "managed-project-id",
          addedAt: now,
          lastUsed: now,
          enabled: true,
          cachedQuotaUpdatedAt: now,
          cachedQuota: {
            "gemini-pro": {
              remainingFraction: 0,
              modelCount: 1,
            },
          },
        },
      ],
      activeIndex: 0,
    });

    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({
          access_token: "access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("v1internal:generateContent")) {
        return new Response(JSON.stringify({
          response: {
            candidates: [
              {
                content: { parts: [{ text: "ok" }], role: "model" },
                finishReason: "STOP",
                index: 0,
              },
            ],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("1.2.3");
    }));

    try {
      const loader = await loadRoute(
        async () => ({
          type: "oauth",
          refresh: formatRefreshParts({
            refreshToken: "refresh-token",
            projectId: "project-id",
            managedProjectId: "managed-project-id",
          }),
          access: "access-token",
          expires: now + 60_000,
        }),
      );

      const response = await (loader as { fetch: typeof fetch }).fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
        },
      );

      expect(response.status).toBe(200);
      expect(fetchedUrls, JSON.stringify(fetchedUrls)).toContain(
        "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks aggregate soft quota against the preferred Gemini CLI pool", async () => {
    const configDir = join(tmpdir(), `opencode-antigravity-cli-quota-${process.pid}-${Date.now()}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "antigravity.json"), JSON.stringify({
      cli_first: true,
      max_rate_limit_wait_seconds: 1,
      agy_sdk: {
        enabled: false,
        prefer_for_gemini: false,
        api_key_fallback: false,
        cloud_projects: [],
      },
    }));
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "refresh-token",
          projectId: "project-id",
          managedProjectId: "managed-project-id",
          addedAt: Date.now(),
          lastUsed: Date.now(),
          enabled: true,
        },
      ],
      activeIndex: 0,
    });
    const selectionSpy = vi.spyOn(AccountManager.prototype, "getCurrentOrNextForFamily").mockReturnValue(null);
    const aggregateSpy = vi.spyOn(AccountManager.prototype, "areAllAccountsOverSoftQuota").mockReturnValue(false);
    const waitSpy = vi.spyOn(AccountManager.prototype, "getMinWaitTimeForFamily").mockReturnValue(2_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected", { status: 500 })));

    try {
      const loader = await loadRoute(
        async () => ({
          type: "oauth",
          refresh: formatRefreshParts({
            refreshToken: "refresh-token",
            projectId: "project-id",
            managedProjectId: "managed-project-id",
          }),
          access: "access-token",
          expires: Date.now() + 60_000,
        }),
      );

      await expect(
        (loader as { fetch: typeof fetch }).fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
          { method: "POST", body: "{}" },
        ),
      ).rejects.toThrow(
        /All 1 account\(s\) rate-limited for gemini-2\.5-pro \(test@example\.com\)\..*raise max_rate_limit_wait_seconds \(now 1s\)/,
      );

      expect(aggregateSpy).toHaveBeenCalledWith(
        "gemini",
        90,
        expect.any(Number),
        "gemini-2.5-pro",
        "gemini-cli",
      );
    } finally {
      selectionSpy.mockRestore();
      aggregateSpy.mockRestore();
      waitSpy.mockRestore();
      vi.unstubAllGlobals();
      if (previousConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not report revoked credentials when promoted-from-disk OAuth hits invalid_grant", async () => {
    // Disk holds an OAuth account; OpenCode hands us api-key auth. When the
    // (only) promoted OAuth account fails with invalid_grant, OpenCode's
    // api-key connection is fine and must not be marked as needing sign-in.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "test@example.com",
          refreshToken: "fake-refresh-token",
          projectId: "fake-project",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      // Force token refresh to fail with invalid_grant so the cleanup path runs.
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "test-stop" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }));
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAccountsRevoked = vi.fn(async () => undefined);
    vi.mocked(storageModule.saveAccounts).mockClear();
    vi.mocked(storageModule.removeAccountFromStorage).mockClear();

    try {
      const loader = await loadRoute(async () => ({ type: "api", key: "secret" }), onAccountsRevoked);

      // Drive the OAuth fetch handler through the invalid_grant path.
      // It will throw "Google revoked the sign-in of every Antigravity account...".
      try {
        await (loader as { fetch: typeof fetch }).fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
          { method: "POST", body: "{}" },
        );
      } catch {
        // Expected.
      }

      // First, prove the invalid_grant cleanup path was actually exercised — the
      // OAuth fetch handler must have attempted a token refresh against Google.
      const tokenRefreshCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("oauth2.googleapis.com"),
      );
      expect(tokenRefreshCalls.length).toBeGreaterThan(0);

      expect(onAccountsRevoked).not.toHaveBeenCalled();
      // The account is kept, disabled and marked revoked, so it can be signed in again.
      expect(storageModule.removeAccountFromStorage).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        const saved = vi.mocked(storageModule.saveAccounts).mock.calls.at(-1)?.[0];
        expect(saved?.accounts[0]).toMatchObject({ refreshToken: "fake-refresh-token", enabled: false });
        expect(saved?.accounts[0]?.revokedAt).toBeTypeOf("number");
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries an empty response on the same endpoint, counting attempts per request", async () => {
    const now = Date.now();
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [{
        email: "test@example.com",
        refreshToken: "refresh-token",
        projectId: "project-id",
        managedProjectId: "managed-project-id",
        addedAt: now,
        lastUsed: now,
        enabled: true,
      }],
      activeIndex: 0,
    });
    const generateCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(":generateContent")) {
        generateCalls.push(url);
        const candidates = generateCalls.length === 1
          ? []
          : [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }];
        return Response.json({ response: { candidates } });
      }
      return new Response("1.2.3");
    }));

    try {
      const loader = await loadRoute(
        async () => ({
          type: "oauth",
          refresh: formatRefreshParts({ refreshToken: "refresh-token", projectId: "project-id", managedProjectId: "managed-project-id" }),
          access: "access-token",
          expires: now + 3_600_000,
        }),
        undefined,
        { empty_response_retry_delay_ms: 500,agy_sdk: { enabled: false, prefer_for_gemini: false, api_key_fallback: false, cloud_projects: [] } },
      );

      const response = await loader!.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
      );

      expect(response.status).toBe(200);
      expect(generateCalls).toHaveLength(2);
      expect(generateCalls[1]).toBe(generateCalls[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks the host for a new sign-in when its OAuth credential's accounts are all revoked", async () => {
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "test@example.com", refreshToken: "fake-refresh-token", projectId: "fake-project", addedAt: 0, lastUsed: 0, enabled: true },
      ],
      activeIndex: 0,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("1.2.3");
    }));
    const onAccountsRevoked = vi.fn(async () => undefined);

    try {
      const loader = await loadRoute(
        async () => ({ type: "oauth", refresh: "fake-refresh-token|fake-project", access: "", expires: 0 }),
        onAccountsRevoked,
      );

      await expect(loader!.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.1-pro:generateContent",
        { method: "POST", body: "{}" },
      )).rejects.toThrow("Google revoked the sign-in of every Antigravity account");
      expect(onAccountsRevoked).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// 404-fallback block: when the Antigravity backend returns NOT_FOUND for a
// model that the public Gemini API can serve, the plugin must route to the
// api-key path (agy-sdk) instead of returning the raw 404 to the caller.
// ---------------------------------------------------------------------------
import { formatRefreshParts } from "./plugin/auth";

describe("createAntigravityCore loader 404→agy-sdk fallback", () => {
  // Isolated XDG_CONFIG_HOME so the real user config file is never loaded.
  // Without a config file, schema defaults apply: agy_sdk.enabled=true,
  // agy_sdk.api_key_fallback=true.
  let tmpConfigHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Create a fresh, empty temp dir for each test.
    tmpConfigHome = join(tmpdir(), `opencode-antigravity-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmpConfigHome, { recursive: true });

    // Save env vars we may touch.
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.OPENCODE_ANTIGRAVITY_API_KEYS = process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

    // Point XDG_CONFIG_HOME at the empty temp dir so no real config is read.
    process.env.XDG_CONFIG_HOME = tmpConfigHome;

    // Reset the storage mock state.
    vi.mocked(storageModule.loadAccounts).mockReset();
    vi.mocked(storageModule.saveAccounts).mockReset();
  });

  afterEach(() => {
    // Restore saved env vars (undefined means delete).
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    vi.unstubAllGlobals();
  });

  /**
   * Build a valid OAuth auth string that makes ensureProjectContext() return
   * immediately (no network call) by embedding a managedProjectId.
   */
  function buildOAuthGetAuth() {
    const refresh = formatRefreshParts({
      refreshToken: "r",
      projectId: "p",
      managedProjectId: "managed-proj",
    });
    const auth = {
      type: "oauth" as const,
      refresh,
      access: "valid-access-token",
      expires: Date.now() + 3_600_000,
    };
    return async () => auth;
  }

  /**
   * Build a fetch mock that:
   * - Returns 404 for ALL Antigravity backend endpoints.
   * - Returns 200 with SSE body for `generativelanguage.googleapis.com` calls
   *   that carry an `x-goog-api-key` header (the agy-sdk fallback path).
   * - Returns `{models:[]}` for model-list GETs to generativelanguage.googleapis.com.
   * - Returns a token JSON for oauth2.googleapis.com (safety; may not be hit).
   * - Returns a benign 200 for anything else.
   */
  function buildFetchMock({
    hasFallbackKey,
    backendStatus = 404,
    backendMessage,
  }: {
    hasFallbackKey: boolean;
    backendStatus?: number;
    backendMessage?: string;
  }) {
    const SSE_BODY =
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"},"finishReason":"STOP","index":0}]}\n\n';

    return vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;

      // Antigravity backend endpoints → return the configured status (default 404).
      if (
        url.includes("cloudcode-pa.googleapis.com") ||
        url.includes("daily-cloudcode-pa") ||
        url.includes("autopush-cloudcode-pa")
      ) {
        const backendBody = backendStatus === 403
          ? { error: { code: 403, message: backendMessage ?? "Permission denied.", status: "PERMISSION_DENIED" } }
          : { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } };
        return new Response(JSON.stringify(backendBody), {
          status: backendStatus,
          headers: { "content-type": "application/json" },
        });
      }

      // Gemini public API.
      if (url.includes("generativelanguage.googleapis.com")) {
        // Model-list GET (no :streamGenerateContent / :generateContent action).
        if (url.includes("/models") && !url.includes(":")) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        // Check for the api-key header — this is what the agy-sdk path injects.
        let hasApiKey = false;
        const headersArg = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        if (headersArg) {
          if (headersArg instanceof Headers) {
            hasApiKey = headersArg.has("x-goog-api-key");
          } else if (typeof headersArg === "object") {
            hasApiKey = "x-goog-api-key" in (headersArg as Record<string, string>);
          }
        }

        if (hasApiKey && hasFallbackKey) {
          // This is the agy-sdk fallback call — return 200.
          return new Response(SSE_BODY, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        // Fallback key not configured or not an api-key call — 200 generic.
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Token refresh endpoint (safety net; may not be reached since access token is pre-supplied).
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "valid-access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Version check / anything else → benign 200.
      return new Response("1.2.3");
    });
  }

  it("falls back to agy-sdk when Antigravity backend returns 404 for a routable Gemini model", async () => {
    // Provide a fallback key so getAgySdkCredentials() returns a credential.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    // Disk holds one usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "t@example.com",
          refreshToken: "r",
          projectId: "p",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: true });
    vi.stubGlobal("fetch", fetchMock);


    const getAuth = buildOAuthGetAuth();
    const loader = await loadRoute(getAuth);

    // antigravity-gemini-3.8-flash is routable (strips to gemini-3.8-flash which is
    // a public API model), so isAgySdkSupportedRequest returns true.
    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The fallback must succeed and return 200.
    expect(res.status).toBe(200);

    // Verify that a request to generativelanguage.googleapis.com with an
    // x-goog-api-key header was made (that's the agy-sdk fallback path).
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBeGreaterThan(0);
  });

  it("returns the 404 Response without throwing when no api-key fallback is configured", async () => {
    // Ensure NO credentials are available so tryAgySdkFallbackForRequest returns null.
    delete process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    // Disk holds one usable OAuth account.
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "t@example.com",
          refreshToken: "r",
          projectId: "p",
          addedAt: 0,
          lastUsed: 0,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: false });
    vi.stubGlobal("fetch", fetchMock);


    const getAuth = buildOAuthGetAuth();
    const loader = await loadRoute(getAuth);

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse";

    // Must RESOLVE (not throw) — status 404 because no api-key fallback is available.
    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    expect(res.status).toBe(404);
  });

  it("does NOT fall back to agy-sdk on a generic 403 from the Antigravity backend (stays on Antigravity)", async () => {
    // A generic 403 is a permission/credential signal (expired token, IP/ACL/
    // verification denial), NOT "model unavailable". Even with a fallback key
    // configured, the plugin must surface the 403 rather than silently routing
    // to the api-key path — doing so would mask a real account-access problem
    // and shift the user onto their API key unknowingly. Only 404 NOT_FOUND and
    // the specific "permission denied on resource project" 403 (see the test
    // below) trigger the agy-sdk fallback.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "t@example.com", refreshToken: "r", projectId: "p", addedAt: 0, lastUsed: 0, enabled: true },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({ hasFallbackKey: true, backendStatus: 403 });
    vi.stubGlobal("fetch", fetchMock);


    const getAuth = buildOAuthGetAuth();
    const loader = await loadRoute(getAuth);

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The backend 403 must be surfaced — NOT replaced by the fallback's 200.
    expect(res.status).toBe(403);

    // And the agy-sdk fallback must NOT have been invoked (no x-goog-api-key request).
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBe(0);
  });

  it("falls back to agy-sdk on a 403 'permission denied on resource project' from the Antigravity backend", async () => {
    // Some 403s are a project-scoped entitlement gate on the resolved backend
    // model id (e.g. a staged Google rollout of a new Flash effort tier)
    // rather than a credential problem.
    // Retrying other Antigravity endpoints can't help, but the public Gemini
    // API can still serve the model — so this specific 403 should fall back
    // just like a 404 does.
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-fallback-key";

    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "t@example.com", refreshToken: "r", projectId: "p", addedAt: 0, lastUsed: 0, enabled: true },
      ],
      activeIndex: 0,
    });

    const fetchMock = buildFetchMock({
      hasFallbackKey: true,
      backendStatus: 403,
      backendMessage: "Permission denied on resource project ata-watch-481914-b3.",
    });
    vi.stubGlobal("fetch", fetchMock);


    const getAuth = buildOAuthGetAuth();
    const loader = await loadRoute(getAuth);

    const requestUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent?alt=sse";

    const res = await (loader as { fetch: typeof fetch }).fetch(requestUrl, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });

    // The fallback must succeed and return 200, not the raw 403.
    expect(res.status).toBe(200);

    // Verify the agy-sdk fallback path (x-goog-api-key header) was used.
    const apiKeyFallbackCalls = fetchMock.mock.calls.filter(([inputArg, initArg]) => {
      const u = typeof inputArg === "string" ? inputArg : (inputArg as Request).url;
      if (!u.includes("generativelanguage.googleapis.com")) return false;
      const hdrs = (initArg as RequestInit | undefined)?.headers;
      if (!hdrs) return false;
      if (hdrs instanceof Headers) return hdrs.has("x-goog-api-key");
      return "x-goog-api-key" in (hdrs as Record<string, string>);
    });
    expect(apiKeyFallbackCalls.length).toBeGreaterThan(0);
  });
});

describe("createAntigravityCore capacity-exhaustion header-style fallback (review fix 1)", () => {
  let tmpConfigHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpConfigHome = join(tmpdir(), `opencode-antigravity-cap-${process.pid}-${Date.now()}`);
    mkdirSync(tmpConfigHome, { recursive: true });
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.OPENCODE_ANTIGRAVITY_API_KEYS = process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    savedEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    savedEnv.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    process.env.XDG_CONFIG_HOME = tmpConfigHome;
    // No API keys → no agy-sdk fallback path, isolating the header-style fallback.
    delete process.env.OPENCODE_ANTIGRAVITY_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    vi.mocked(storageModule.loadAccounts).mockReset();
    // Reset module-level singletons so a prior test's api-key cooldown or per-account
    // rate-limit state can't leak into this one (they persist across the module).
    resetAgySdkCredentialStateForTests();
    loopEscapeTestHooks.resetAllInternalState();
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const headerValue = (
    input: RequestInfo,
    init: RequestInit | undefined,
    name: string,
  ): string | null => {
    const fromInit = init?.headers;
    const sources = [fromInit, input instanceof Request ? input.headers : undefined];
    for (const h of sources) {
      if (!h) continue;
      if (h instanceof Headers) {
        const v = h.get(name);
        if (v) return v;
      } else if (Array.isArray(h)) {
        const found = h.find(([k]) => k.toLowerCase() === name.toLowerCase());
        if (found) return found[1];
      } else if (typeof h === "object") {
        const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
        if (key) return (h as Record<string, string>)[key] ?? null;
      }
    }
    return null;
  };

  it("capacity-exhausted on antigravity retries gemini-cli quota on the SAME account before rotating", async () => {
    const now = Date.now();
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        {
          email: "solo@example.com",
          refreshToken: "refresh-token",
          projectId: "project-id",
          managedProjectId: "managed-project-id",
          addedAt: now,
          lastUsed: now,
          enabled: true,
        },
      ],
      activeIndex: 0,
    });

    let antigravityContentCalls = 0;
    let geminiCliContentCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;

      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Antigravity backend (all endpoints contain "cloudcode-pa"). gemini-cli also
      // uses the PROD host, so distinguish the pools by User-Agent.
      if (url.includes("cloudcode-pa")) {
        const ua = headerValue(input, init, "user-agent") ?? "";
        const isGeminiCli = ua.includes("nodejs-client");
        if (isGeminiCli) {
          geminiCliContentCalls++;
          return new Response(
            JSON.stringify({
              response: {
                candidates: [
                  { content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Antigravity pool: always capacity-exhausted (503 → MODEL_CAPACITY_EXHAUSTED).
        antigravityContentCalls++;
        return new Response(
          JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    const loader = await loadRoute(
      async () => ({
        type: "oauth" as const,
        refresh: formatRefreshParts({
          refreshToken: "refresh-token",
          projectId: "project-id",
          managedProjectId: "managed-project-id",
        }),
        access: "access-token",
        expires: now + 3_600_000,
      }),
    );

    // Fake timers so the capacity exponential backoffs (1s→2s→4s per endpoint)
    // don't make the test take ~20s of real time.
    vi.useFakeTimers();
    const fetchPromise = (loader as { fetch: typeof fetch }).fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }) },
    );
    let settled = false;
    fetchPromise.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 80 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const response = await fetchPromise;
    vi.useRealTimers();

    // The request must ultimately SUCCEED via the gemini-cli quota on the same account,
    // proving the capacity path fell back to the alternate quota pool before rotating.
    expect(response.status, `antigravity=${antigravityContentCalls} geminiCli=${geminiCliContentCalls}`).toBe(200);
    expect(antigravityContentCalls).toBeGreaterThan(0); // antigravity was tried and capacity-exhausted
    expect(geminiCliContentCalls).toBeGreaterThan(0); // then gemini-cli was tried on the SAME account
  }, 20_000);

  // Regression for the round-2/round-3 HIGH: tryAgySdkFallbackForRequest can return
  // its last RETRYABLE failure (429 and, after round-3, transient 5xx like 500). The
  // capacity-escape must NOT treat that as terminal — it should keep rotating so a
  // healthy second account gets tried.
  async function runCapacitySdkRetryableRotation(sdkStatus: number, sdkReason: string) {
    process.env.OPENCODE_ANTIGRAVITY_API_KEYS = "test-sdk-key";
    const now = Date.now();
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "a@example.com", refreshToken: "refresh-A", projectId: "proj", managedProjectId: "managed", addedAt: now, lastUsed: now, enabled: true },
        { email: "b@example.com", refreshToken: "refresh-B", projectId: "proj", managedProjectId: "managed", addedAt: now, lastUsed: now, enabled: true },
      ],
      activeIndex: 0,
    });

    let sdkApiKeyCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // OAuth content path (both quota pools) → always capacity-exhausted (503).
      if (url.includes("cloudcode-pa")) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        // agy-sdk fallback (api-key path) → the retryable failure under test.
        if (headerValue(input, init, "x-goog-api-key")) {
          sdkApiKeyCalls++;
          return new Response(
            JSON.stringify({ error: { code: sdkStatus, message: sdkReason, status: "ERROR" } }),
            { status: sdkStatus, headers: { "content-type": "application/json" } },
          );
        }
        // Model-list GET.
        return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("1.2.3");
    });
    vi.stubGlobal("fetch", fetchMock);

    // Observe which account indices the router actually selects, without replacing
    // the real selection logic.
    const selectedIndices: number[] = [];
    const originalSelect = AccountManager.prototype.getCurrentOrNextForFamily;
    const selectSpy = vi
      .spyOn(AccountManager.prototype, "getCurrentOrNextForFamily")
      .mockImplementation(function (this: AccountManager, ...selectArgs: unknown[]) {
        const acct = (originalSelect as (...a: unknown[]) => { index: number } | null).apply(this, selectArgs);
        if (acct) selectedIndices.push(acct.index);
        return acct as ReturnType<typeof originalSelect>;
      });

    try {
      const loader = await loadRoute(
        async () => ({
          type: "oauth" as const,
          refresh: formatRefreshParts({ refreshToken: "refresh-A", projectId: "proj", managedProjectId: "managed" }),
          access: "access-token",
          expires: now + 3_600_000,
        }),
      );

      vi.useFakeTimers();
      const fetchPromise = (loader as { fetch: typeof fetch }).fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }) },
      );
      let settled = false;
      fetchPromise.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 200 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await fetchPromise;
      vi.useRealTimers();

      // The SDK fallback was attempted (proving we reached the capacity SDK step)...
      expect(sdkApiKeyCalls).toBeGreaterThan(0);
      // ...and because the SDK status was retryable, the router rotated to the SECOND
      // account instead of returning the SDK failure. Both accounts must be selected.
      expect(selectedIndices, `selected=${JSON.stringify(selectedIndices)}`).toContain(0);
      expect(selectedIndices, `selected=${JSON.stringify(selectedIndices)}`).toContain(1);
    } finally {
      selectSpy.mockRestore();
      vi.useRealTimers();
    }
  }

  it("capacity-exhausted both pools + RETRYABLE SDK 429 rotates to the healthy second account", async () => {
    await runCapacitySdkRetryableRotation(429, "Resource has been exhausted");
  }, 20_000);

  it("capacity-exhausted both pools + transient SDK 500 rotates to the healthy second account", async () => {
    await runCapacitySdkRetryableRotation(500, "Internal server error");
  }, 20_000);
});

describe("isRemovedModelId", () => {
  it("filters the removed Gemini families", async () => {
    const { __testExports } = await import("./plugin");
    for (const id of [
      "gemini-2.5-pro",
      "gemini-3-pro",
      "gemini-3-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "antigravity-gemini-3.5-flash-high",
      "gemini-3.6-flash",
      "antigravity-gemini-3.6-flash-medium",
      "gemini-3.7-flash",
      "antigravity-gemini-3.7-flash",
      "gemini-3.7-flash-low",
    ]) {
      expect(__testExports.isRemovedModelId(id), `id=${id}`).toBe(true);
    }
  });
});

describe("Gemini 3.8 Flash model surface", () => {
  it("does not filter out the Gemini 3.8 Flash ids", async () => {
    const { __testExports } = await import("./plugin");
    for (const id of [
      "gemini-3.8-flash",
      "antigravity-gemini-3.8-flash",
      "antigravity-gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
    ]) {
      expect(__testExports.isRemovedModelId(id), `id=${id}`).toBe(false);
    }
  });

  it("advertises video and audio input for 3.8 Flash", async () => {
    const { OPENCODE_MODEL_DEFINITIONS } = await import("./plugin/config/models");
    const { toV2Model } = await import("./v2/models");

    const model = toV2Model(
      "antigravity-gemini-3.8-flash",
      OPENCODE_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash"]!,
    );

    expect(model.capabilities.input).toEqual(expect.arrayContaining(["video", "audio"]));
  });
});

describe("replaceStoredAccount", () => {
  const pool = {
    version: 4 as const,
    activeIndex: 0,
    activeIndexByFamily: { claude: 0, gemini: 0 },
    accounts: [
      { email: "a@example.com", refreshToken: "token-a", addedAt: 1, lastUsed: 1 },
      {
        email: "b@example.com",
        refreshToken: "token-b-old",
        projectId: "project-b",
        addedAt: 2,
        lastUsed: 2,
        verificationRequired: true,
        rateLimitResetTimes: { gemini: Date.now() + 60_000 },
      },
    ],
  };
  const signIn = {
    type: "success" as const,
    refresh: "token-b-new",
    access: "access",
    expires: 0,
    email: "b@example.com",
    projectId: "",
  };

  beforeEach(() => {
    vi.mocked(storageModule.loadAccounts).mockResolvedValue(structuredClone(pool) as never);
    vi.mocked(storageModule.saveAccounts).mockClear();
    vi.mocked(storageModule.saveAccountsReplace).mockClear();
  });

  it("replaces the entry in place without merging the old one back", async () => {
    const { replaceStoredAccount } = await import("./plugin/oauth-flow");

    await replaceStoredAccount(1, signIn);

    expect(storageModule.saveAccounts).not.toHaveBeenCalled();
    expect(storageModule.saveAccountsReplace).toHaveBeenCalledTimes(1);
    const written = vi.mocked(storageModule.saveAccountsReplace).mock.calls[0]![0];
    expect(written.accounts).toHaveLength(2);
    expect(written.accounts[0]).toEqual(pool.accounts[0]);
    expect(written.accounts[1]).toEqual({
      email: "b@example.com",
      refreshToken: "token-b-new",
      projectId: "project-b",
      managedProjectId: undefined,
      addedAt: 2,
      lastUsed: expect.any(Number),
    });
  });

  it("tombstones the old refresh token so a running server cannot restore it", async () => {
    const { replaceStoredAccount } = await import("./plugin/oauth-flow");

    await replaceStoredAccount(1, signIn);

    const written = vi.mocked(storageModule.saveAccountsReplace).mock.calls[0]![0];
    expect(written.deletedRefreshTokenHashes).toEqual([storageModule.hashRefreshToken("token-b-old")]);
  });

  it("does not tombstone a refresh token that Google returned unchanged", async () => {
    const { replaceStoredAccount } = await import("./plugin/oauth-flow");

    await replaceStoredAccount(1, { ...signIn, refresh: "token-b-old" });

    const written = vi.mocked(storageModule.saveAccountsReplace).mock.calls[0]![0];
    expect(written.deletedRefreshTokenHashes).toBeUndefined();
    expect(written.accounts[1]).not.toHaveProperty("verificationRequired");
  });
});
