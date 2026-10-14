import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugin/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../plugin/storage")>();
  return {
    ...original,
    loadAccounts: vi.fn(async () => null),
    saveAccounts: vi.fn(async () => undefined),
    saveAccountsReplace: vi.fn(async () => undefined),
    removeAccountFromStorage: vi.fn(async () => undefined),
    clearAccounts: vi.fn(async () => undefined),
  };
});

vi.mock("../plugin/version", () => ({
  initAntigravityVersion: vi.fn(async () => undefined),
}));

const { default: plugin, cliCommand, OAUTH_METHOD_ID, PLUGIN_ID, sdkPackage, toV2Authorization } = await import(
  "./plugin"
);
const storageModule = await import("../plugin/storage");

type Callback = (input: any) => unknown;

interface FakeModel {
  package?: string;
  [key: string]: unknown;
}

/** Records every registration the plugin makes against a V2 context. */
function createFakeContext() {
  const registrations = {
    provider: [] as Callback[],
    integration: [] as Callback[],
    tool: [] as Callback[],
    aisdk: [] as Array<{ name: string; callback: Callback; options?: { providerID?: string } }>,
  };
  const abortSignals: AbortSignal[] = [];
  const registration = { dispose: async () => {} };
  const ctx = {
    app: { name: "test", version: "2.0.28", channel: "latest" },
    location: { directory: process.cwd() },
    options: {},
    provider: {
      transform: vi.fn(async (callback: Callback) => {
        registrations.provider.push(callback);
        return registration;
      }),
      reload: vi.fn(async () => {}),
    },
    integration: {
      transform: vi.fn(async (callback: Callback) => {
        registrations.integration.push(callback);
        return registration;
      }),
      reload: vi.fn(async () => {}),
      connection: {
        active: vi.fn(async () => undefined),
        resolve: vi.fn(async () => undefined),
        status: vi.fn(async () => {}),
      },
    },
    tool: {
      transform: vi.fn(async (callback: Callback) => {
        registrations.tool.push(callback);
        return registration;
      }),
    },
    aisdk: {
      hook: vi.fn(async (name: string, callback: Callback, options?: { providerID?: string }) => {
        registrations.aisdk.push({ name, callback, options });
        return registration;
      }),
    },
    event: {
      subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => {
        abortSignals.push(signal);
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          },
        };
      }),
    },
    session: { prompt: vi.fn(), interrupt: vi.fn() },
  };
  return { ctx, registrations, abortSignals };
}

/** A minimal provider editor holding the built-in `google` provider. */
function createProviderEditor(models: Record<string, FakeModel>) {
  const provider: Record<string, unknown> = {
    id: "google",
    name: "Google",
    activation: "auto",
    package: "@opencode/ai/providers/google",
  };
  const inventory = new Map<string, FakeModel>(Object.entries(models));
  return {
    provider,
    inventory,
    editor: {
      get: (id: string) => (id === "google" ? { provider, models: new Map(inventory) } : undefined),
      update: (_id: string, update: (draft: Record<string, unknown>) => void) => update(provider),
      models: {
        update: (_providerID: string, modelID: string, update: (draft: FakeModel) => void) => {
          const draft = inventory.get(modelID) ?? { id: modelID };
          update(draft);
          inventory.set(modelID, draft);
        },
        remove: (_providerID: string, modelID: string) => inventory.delete(modelID),
      },
    },
  };
}

async function setup() {
  const fake = createFakeContext();
  const cleanup = await plugin.setup(fake.ctx as never);
  return { ...fake, cleanup };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  vi.mocked(storageModule.loadAccounts).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("V2 plugin definition", () => {
  it("has a stable id", () => {
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(PLUGIN_ID).toBe("opencode-antigravity-auth");
  });

  it("points the google provider at this package's AI SDK module", () => {
    expect(sdkPackage("file:///pkg/dist/src/v2/plugin.js")).toBe("aisdk:file:///pkg/dist/src/v2/sdk.js");
    expect(sdkPackage("file:///pkg/src/v2/plugin.ts")).toBe("aisdk:file:///pkg/src/v2/sdk.ts");
  });

  it("returns a cleanup that ends the event subscription", async () => {
    const { cleanup, abortSignals } = await setup();
    expect(abortSignals).toHaveLength(1);
    expect(abortSignals[0]!.aborted).toBe(false);
    await (cleanup as () => void)();
    expect(abortSignals[0]!.aborted).toBe(true);
  });
});

describe("V2 provider transform", () => {
  it("routes google through the AI SDK package and publishes Gemini 3.8 Flash", async () => {
    const { registrations, cleanup } = await setup();
    const { provider, inventory, editor } = createProviderEditor({
      "gemini-2.5-flash": {},
      "gemini-3.7-flash": { package: "@ai-sdk/google" },
    });

    registrations.provider[0]!(editor);

    expect(provider.package).toBe(sdkPackage(new URL("./plugin.ts", import.meta.url).href));
    // No accounts on disk: activation stays with OpenCode's own credentials.
    expect(provider.activation).toBe("auto");
    expect(inventory.has("gemini-2.5-flash")).toBe(false);
    expect(inventory.get("gemini-3.7-flash")?.package).toBeUndefined();

    const flash38 = inventory.get("antigravity-gemini-3.8-flash") as Record<string, any>;
    expect(flash38.name).toBe("Gemini 3.8 Flash (Antigravity)");
    expect(flash38.limit).toEqual({ context: 1048576, output: 65536 });
    expect(flash38.variants.map((variant: { id: string }) => variant.id)).toEqual(["low", "medium", "high"]);
    expect(inventory.has("gemini-3.8-flash")).toBe(true);
    await (cleanup as () => void)();
  });

  it("enables the provider when the account pool on disk has accounts", async () => {
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [{ refreshToken: "refresh-token", addedAt: 0, lastUsed: 0 }],
      activeIndex: 0,
    } as never);
    const { registrations, cleanup } = await setup();
    const { provider, editor } = createProviderEditor({});

    registrations.provider[0]!(editor);

    expect(provider.activation).toBe("enabled");
    await (cleanup as () => void)();
  });
});

describe("V2 AI SDK hook", () => {
  it("is scoped to the google provider", async () => {
    const { registrations, cleanup } = await setup();
    const hook = registrations.aisdk.find((entry) => entry.name === "sdk");
    expect(hook?.options).toEqual({ providerID: "google" });

    const other = { model: { providerID: "openai" }, options: {} } as { sdk?: unknown; model: unknown; options: unknown };
    await hook!.callback(other);
    expect(other.sdk).toBeUndefined();
    await (cleanup as () => void)();
  });

  it("builds a Google SDK whose requests go through the plugin fetch", async () => {
    const { registrations, cleanup } = await setup();
    const hook = registrations.aisdk.find((entry) => entry.name === "sdk")!;
    const hostFetch = vi.fn(async () =>
      Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "PONG" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    );
    const event = {
      model: { providerID: "google", id: "gemini-3.8-flash" },
      package: "file:///sdk.js",
      options: { name: "google", apiKey: "test-key", fetch: hostFetch },
    } as { sdk?: { languageModel(id: string): any }; model: unknown; package: string; options: unknown };

    await hook.callback(event);
    const result = await event.sdk!.languageModel("gemini-3.8-flash").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    // No OAuth accounts: the core loader hands requests to the host fetch, using the host's key.
    expect(hostFetch).toHaveBeenCalledTimes(1);
    const [url, init] = hostFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/models/gemini-3.8-flash:generateContent");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("test-key");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "PONG" })]);
    await (cleanup as () => void)();
  });
});

describe("V2 integration method", () => {
  it("registers the Antigravity OAuth method on the google integration", async () => {
    const { registrations, cleanup } = await setup();
    const update = vi.fn();
    registrations.integration[0]!({ get: (id: string) => (id === "google" ? { id, name: "Google" } : undefined), method: { update } });

    expect(update).toHaveBeenCalledTimes(1);
    const registration = update.mock.calls[0]![0];
    expect(registration.integrationID).toBe("google");
    expect(registration.method).toMatchObject({
      id: OAUTH_METHOD_ID,
      type: "oauth",
      label: "OAuth with Google (Antigravity)",
    });
    expect(typeof registration.authorize).toBe("function");
    expect(typeof registration.refresh).toBe("function");
    expect(registration.label({ metadata: { email: "user@example.com" } })).toBe("user@example.com");
    await (cleanup as () => void)();
  });

  it("asks for an action listing the accounts in the pool", async () => {
    vi.mocked(storageModule.loadAccounts).mockResolvedValue({
      version: 4,
      accounts: [
        { email: "a@example.com", refreshToken: "r1", addedAt: 0, lastUsed: 0 },
        { email: "b@example.com", refreshToken: "r2", addedAt: 0, lastUsed: 0, enabled: false },
      ],
      activeIndex: 0,
    } as never);
    const { registrations, cleanup } = await setup();
    const update = vi.fn();
    registrations.integration[0]!({ get: () => ({ id: "google", name: "Google" }), method: { update } });

    const [field] = update.mock.calls[0]![0].method.form;
    expect(field).toMatchObject({ key: "action", type: "string", default: "add", required: true });
    expect(field.options.map((option: { label: string }) => option.label)).toEqual([
      "Add a new account",
      "Re-authenticate a@example.com",
      "Re-authenticate b@example.com",
    ]);
    expect(field.description).toContain(cliCommand());
    await (cleanup as () => void)();
  });

  it("rejects an action the form did not offer before opening the browser", async () => {
    const { registrations, cleanup } = await setup();
    const update = vi.fn();
    registrations.integration[0]!({ get: () => ({ id: "google", name: "Google" }), method: { update } });

    await expect(update.mock.calls[0]![0].authorize({ action: "reauth:0" })).rejects.toThrow("Unknown action");
    await (cleanup as () => void)();
  });

  it.runIf(process.platform === "win32")("names the account manager CLI next to this module", () => {
    expect(cliCommand("file:///C:/pkg/dist/src/v2/plugin.js")).toBe('bun "C:/pkg/dist/src/v2/cli.js"');
  });

  it("does nothing when the google integration is missing", async () => {
    const { registrations, cleanup } = await setup();
    const update = vi.fn();
    registrations.integration[0]!({ get: () => undefined, method: { update } });
    expect(update).not.toHaveBeenCalled();
    await (cleanup as () => void)();
  });
});

describe("toV2Authorization", () => {
  const success = {
    type: "success" as const,
    refresh: "refresh|project",
    access: "access",
    expires: 123,
    email: "user@example.com",
    projectId: "project",
  };

  it("passes an auto flow's callback as a credential promise", async () => {
    const authorization = toV2Authorization({
      url: "https://accounts.google.com/o/oauth2/auth",
      instructions: "sign in",
      method: "auto",
      callback: async () => success,
    });
    expect(authorization.mode).toBe("auto");
    await expect(authorization.callback).resolves.toEqual({
      type: "oauth",
      methodID: OAUTH_METHOD_ID,
      refresh: "refresh|project",
      access: "access",
      expires: 123,
      metadata: { email: "user@example.com" },
    });
  });

  it("passes a code flow's callback as a function of the code", async () => {
    const callback = vi.fn(async () => success);
    const authorization = toV2Authorization({ url: "u", instructions: "i", method: "code", callback });
    expect(authorization.mode).toBe("code");
    const credential = await (authorization.callback as (code: string) => Promise<unknown>)("the-code");
    expect(callback).toHaveBeenCalledWith("the-code");
    expect(credential).toMatchObject({ type: "oauth", refresh: "refresh|project" });
  });

  it("rejects with the core's error when sign-in fails", async () => {
    const authorization = toV2Authorization({
      url: "u",
      instructions: "i",
      method: "auto",
      callback: async () => ({ type: "failed" as const, error: "denied" }),
    });
    await expect(authorization.callback).rejects.toThrow("denied");
  });
});

describe("V2 google_search tool", () => {
  it("adds the tool with a JSON Schema input and text content result", async () => {
    const { registrations, cleanup } = await setup();
    const add = vi.fn();
    registrations.tool[0]!({ add });

    const tool = add.mock.calls[0]![0];
    expect(tool.name).toBe("google_search");
    expect(tool.input).toMatchObject({ type: "object", required: ["query"] });

    // Not signed in: the core answers with guidance instead of searching.
    const result = await tool.execute({ query: "opencode" }, { signal: new AbortController().signal });
    expect(result.content).toContain("Not authenticated with Antigravity");
    await (cleanup as () => void)();
  });
});
