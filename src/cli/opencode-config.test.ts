import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "jsonc-parser";
import { updateOpencodeConfig } from "./opencode-config";

const OUR_ENTRY = { package: "opencode-antigravity-auth@latest" };

describe("updateOpencodeConfig", () => {
  let tempDir: string;
  let configPath: string;
  let originalXdgConfigHome: string | undefined;
  let originalConfigDir: string | undefined;

  const readConfig = (file = configPath) => JSON.parse(fs.readFileSync(file, "utf-8"));
  const writeConfig = (config: unknown, file = configPath) => fs.writeFileSync(file, JSON.stringify(config));
  const ourEntries = (plugins: unknown[]) =>
    plugins.filter((entry) => JSON.stringify(entry).includes("opencode-antigravity-auth"));

  beforeEach(() => {
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalConfigDir = process.env.OPENCODE_CONFIG_DIR;
    tempDir= fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
    configPath = path.join(tempDir, "opencode.json");
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalConfigDir;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates a V2 config registering the plugin when the file does not exist", async () => {
    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(readConfig()).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugins: [OUR_ENTRY],
    });
  });

  test("moves a 1.x plugin entry to plugins, keeping its version and the other 1.x plugins", async () => {
    writeConfig({ plugin: ["opencode-antigravity-auth@beta", "other-plugin"] });

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(true);
    const written = readConfig();
    expect(written.plugin).toEqual(["other-plugin"]);
    expect(written.plugins).toEqual([{ package: "opencode-antigravity-auth@beta" }]);
  });

  test("drops the 1.x plugin key once our entry was its only member", async () => {
    writeConfig({ plugin: ["opencode-antigravity-auth@latest"] });

    await updateOpencodeConfig({ configPath });

    const written = readConfig();
    expect(written.plugin).toBeUndefined();
    expect(written.plugins).toEqual([OUR_ENTRY]);
  });

  test("does not duplicate an existing plugins entry of any form or version", async () => {
    for (const existing of [
      { package: "opencode-antigravity-auth@beta" },
      { package: "opencode-antigravity-auth", options: { debug: true } },
      "opencode-antigravity-auth@1.6.0",
    ]) {
      writeConfig({ plugins: [existing, { package: "other-plugin" }] });

      await updateOpencodeConfig({ configPath });

      const written = readConfig();
      expect(ourEntries(written.plugins), JSON.stringify(existing)).toEqual([existing]);
      expect(written.plugins).toContainEqual({ package: "other-plugin" });
    }
  });

  test("removes copies of the plugin's model definitions but keeps the user's own models", async () => {
    writeConfig({
      plugin: ["opencode-antigravity-auth@latest"],
      provider: {
        google: {
          apiKey: "test-key",
          models: {
            "antigravity-gemini-3.1-pro": { name: "Gemini 3.1 Pro (Antigravity)" },
            "gemini-3.8-flash": { name: "Gemini 3.8 Flash (Gemini CLI)" },
            "my-tuned-model": { name: "Mine" },
          },
        },
      },
    });

    await updateOpencodeConfig({ configPath });

    const google = readConfig().provider.google;
    expect(google.apiKey).toBe("test-key");
    expect(google.models).toEqual({ "my-tuned-model": { name: "Mine" } });
  });

  test("drops the google models block when only plugin copies were in it", async () => {
    writeConfig({
      provider: {
        google: { region: "us-central1", models: { "antigravity-claude-sonnet-4-6": {} } },
      },
    });

    await updateOpencodeConfig({ configPath });

    expect(readConfig().provider.google).toEqual({ region: "us-central1" });
  });

  test("preserves $schema, other providers and other top-level keys", async () => {
    const existing = {
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      customSetting: { nested: true },
      provider: {
        anthropic: { apiKey: "secret-key", models: { "claude-3": {} } },
        openai: { models: { "gpt-4": {} } },
      },
    };
    writeConfig(existing);

    await updateOpencodeConfig({ configPath });

    const written = readConfig();
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.theme).toBe("dark");
    expect(written.customSetting).toEqual({ nested: true });
    expect(written.provider).toEqual(existing.provider);
  });

  test("adds $schema if missing from existing config", async () => {
    writeConfig({ plugins: [OUR_ENTRY] });

    await updateOpencodeConfig({ configPath });

    expect(readConfig().$schema).toBe("https://opencode.ai/config.json");
  });

  test("writes config with proper JSON formatting (2-space indent)", async () => {
    await updateOpencodeConfig({ configPath });

    const writtenContent = fs.readFileSync(configPath, "utf-8");
    expect(writtenContent).toContain("\n");
    expect(writtenContent).toMatch(/^\{\n {2}/);
  });

  test("returns error result on invalid JSON in existing config", async () => {
    fs.writeFileSync(configPath, "{ invalid json }");

    const result = await updateOpencodeConfig({ configPath });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("edits jsonc config files in place, keeping comments and trailing commas", async () => {
    const jsoncPath = path.join(tempDir, "opencode.jsonc");
    fs.writeFileSync(
      jsoncPath,
      `{
  // Keep existing plugins
  "plugins": [
    { "package": "other-plugin" },
  ],
  "provider": {
    "google": {
      "region": "us-central1",
    },
  },
}`,
    );

    const result = await updateOpencodeConfig({ configPath: jsoncPath });

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(jsoncPath);
    const text = fs.readFileSync(jsoncPath, "utf-8");
    expect(text).toContain("// Keep existing plugins");
    const written = parse(text, [], { allowTrailingComma: true });
    expect(written.plugins).toEqual([{ package: "other-plugin" }, OUR_ENTRY]);
    expect(written.provider.google.region).toBe("us-central1");
    expect(written.$schema).toBe("https://opencode.ai/config.json");
  });

  test("uses OPENCODE_CONFIG_DIR for the default config path", async () => {
    process.env.OPENCODE_CONFIG_DIR = path.join(tempDir, "custom");

    const result = await updateOpencodeConfig();

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(path.join(tempDir, "custom", "opencode.json"));
    expect(readConfig(result.configPath).plugins).toEqual([OUR_ENTRY]);
  });

  test("prefers existing opencode.jsonc when using default config path", async () => {
    const opencodeDir = path.join(tempDir, "opencode");
    const jsonPath = path.join(opencodeDir, "opencode.json");
    const jsoncPath = path.join(opencodeDir, "opencode.jsonc");

    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(jsoncPath, JSON.stringify({ plugins: [{ package: "other-plugin" }] }, null, 2));
    process.env.XDG_CONFIG_HOME = tempDir;

    const result = await updateOpencodeConfig();

    expect(result.success).toBe(true);
    expect(result.configPath).toBe(jsoncPath);
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(jsoncPath)).toBe(true);
  });

  test("creates parent directory if it does not exist", async () => {
    const nestedPath = path.join(tempDir, "nested", "dir", "opencode.json");

    const result = await updateOpencodeConfig({ configPath: nestedPath });

    expect(result.success).toBe(true);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});
