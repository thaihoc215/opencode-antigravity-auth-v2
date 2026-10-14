import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./storage")>();
  return {
    ...original,
    loadAccounts: vi.fn(async () => null),
    saveAccounts: vi.fn(async () => undefined),
    replaceAccountPool: vi.fn(async () => undefined),
  };
});

const { authorizeAntigravity, exchangeAntigravity } = await import("../antigravity/oauth");
const { createBrowserOAuthAuthorization, parseOAuthCallbackInput, persistAccountPool } = await import("./oauth-flow");
const { startOAuthListener } = await import("./server");
const storageModule = await import("./storage");

/** Google's token and userinfo endpoints. */
function stubGoogle() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access", expires_in: 3600, refresh_token: "refresh" });
    }
    if (url.includes("/userinfo")) {
      return Response.json({ email: "user@example.com" });
    }
    return Response.json({ cloudaicompanionProject: "project-1" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_HEADLESS;
});

describe("OAuth state", () => {
  it("sends a random state that does not carry the PKCE verifier", async () => {
    const first = await authorizeAntigravity();
    const second = await authorizeAntigravity();
    const state = new URL(first.url).searchParams.get("state");

    expect(state).toBe(first.state);
    expect(first.state).not.toBe(second.state);
    expect(first.url).not.toContain(first.verifier);
    expect(Buffer.from(first.state, "base64url").toString("utf8")).not.toContain(first.verifier);
  });

  it("refuses a callback whose state belongs to another sign-in, without calling Google", async () => {
    const fetchMock = stubGoogle();
    const authorization = await authorizeAntigravity();

    const result = await exchangeAntigravity(authorization, { code: "attacker-code", state: "forged" });

    expect(result).toMatchObject({ type: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the code with the verifier kept in this process", async () => {
    const fetchMock = stubGoogle();
    const authorization = await authorizeAntigravity();

    const result = await exchangeAntigravity(authorization, { code: "code", state: authorization.state });

    expect(result).toMatchObject({ type: "success", email: "user@example.com" });
    const body = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain(`code_verifier=${authorization.verifier}`);
  });

  it("adds the login hint for re-authentication", async () => {
    const authorization = await authorizeAntigravity("", { loginHint: "user@example.com" });
    expect(new URL(authorization.url).searchParams.get("login_hint")).toBe("user@example.com");
  });
});

describe("parseOAuthCallbackInput", () => {
  it("takes a bare code as belonging to the current sign-in", () => {
    expect(parseOAuthCallbackInput(" the-code ", "state-1")).toEqual({ code: "the-code", state: "state-1" });
  });

  it("keeps the state of a pasted redirect URL for the exchange to check", () => {
    expect(parseOAuthCallbackInput("http://localhost:51121/oauth-callback?code=c&state=other", "state-1"))
      .toEqual({ code: "c", state: "other" });
  });

  it("reports a cancelled consent", () => {
    expect(parseOAuthCallbackInput("http://localhost:51121/oauth-callback?error=access_denied&state=s", "s"))
      .toEqual({ error: "Google sign-in did not complete (access_denied)." });
  });
});

describe("OAuth callback listener", () => {
  it("ignores redirects without this sign-in's state", async () => {
    let listener;
    try {
      listener = await startOAuthListener({ expectedState: "expected", timeoutMs: 5_000 });
    } catch {
      return; // Port 51121 is taken on this machine (another sign-in).
    }
    try {
      const forged = await fetch("http://127.0.0.1:51121/oauth-callback?code=evil&state=forged");
      expect(forged.status).toBe(400);

      const real = await fetch("http://127.0.0.1:51121/oauth-callback?code=good&state=expected");
      expect(real.status).toBe(200);
      const url = await listener.waitForCallback();
      expect(url.searchParams.get("code")).toBe("good");
    } finally {
      await listener.close();
    }
  });
});

describe("createBrowserOAuthAuthorization", () => {
  beforeEach(() => {
    vi.mocked(storageModule.saveAccounts).mockReset();
    vi.mocked(storageModule.loadAccounts).mockResolvedValue(null);
    process.env.OPENCODE_HEADLESS = "1";
  });

  it("uses the paste flow when the browser cannot reach localhost, with an expiry", async () => {
    stubGoogle();
    const before = Date.now();
    const authorization = await createBrowserOAuthAuthorization();

    expect(authorization.method).toBe("code");
    expect(authorization.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
  });

  it("adds the account to the pool before reporting success", async () => {
    stubGoogle();
    const authorization = await createBrowserOAuthAuthorization();
    if (authorization.method !== "code") throw new Error("expected the paste flow");
    const state = new URL(authorization.url).searchParams.get("state");

    const result = await authorization.callback(`http://localhost:51121/oauth-callback?code=c&state=${state}`);

    expect(result).toMatchObject({ type: "success", email: "user@example.com" });
    expect(storageModule.saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("fails the sign-in when the pool cannot be written", async () => {
    stubGoogle();
    vi.mocked(storageModule.saveAccounts).mockRejectedValue(new Error("pool file is locked"));
    const authorization = await createBrowserOAuthAuthorization();
    if (authorization.method !== "code") throw new Error("expected the paste flow");

    const result = await authorization.callback("the-code");

    expect(result).toEqual({ type: "failed", error: "pool file is locked" });
  });

  it("refuses a pasted redirect from another sign-in", async () => {
    const fetchMock = stubGoogle();
    const authorization = await createBrowserOAuthAuthorization();
    if (authorization.method !== "code") throw new Error("expected the paste flow");

    const result = await authorization.callback("http://localhost:51121/oauth-callback?code=c&state=forged");

    expect(result).toMatchObject({ type: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("persistAccountPool", () => {
  beforeEach(() => {
    vi.mocked(storageModule.saveAccounts).mockReset();
    vi.mocked(storageModule.replaceAccountPool).mockReset();
  });

  const signIn = {
    type: "success" as const,
    refresh: "new-token|project",
    access: "a",
    expires: 0,
    email: "new@example.com",
    projectId: "project",
  };

  it("replaces the whole pool when starting fresh", async () => {
    await persistAccountPool([signIn], true);

    expect(storageModule.replaceAccountPool).toHaveBeenCalledTimes(1);
    expect(storageModule.saveAccounts).not.toHaveBeenCalled();
    const written = vi.mocked(storageModule.replaceAccountPool).mock.calls[0]![0];
    expect(written.accounts.map((account) => account.email)).toEqual(["new@example.com"]);
  });

  it("merges into the pool when adding", async () => {
    await persistAccountPool([signIn]);

    expect(storageModule.saveAccounts).toHaveBeenCalledTimes(1);
    expect(storageModule.replaceAccountPool).not.toHaveBeenCalled();
  });
});
