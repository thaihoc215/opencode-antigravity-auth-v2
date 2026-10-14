/**
 * OpenCode configuration file updater (account manager CLI).
 *
 * Registers the plugin in the OpenCode config directory's opencode.json(c) for
 * OpenCode V2. Existing files are edited in place, so comments and formatting
 * in opencode.jsonc survive.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { getConfigDir } from "../plugin/paths";

// =============================================================================
// Types
// =============================================================================

export interface UpdateConfigResult {
  success: boolean;
  configPath: string;
  error?: string;
}

/** A V2 `plugins` entry: a package spec or `{ package, options }`. */
export type PluginEntry = string | { package: string; options?: Record<string, unknown> };

export interface OpencodeConfig {
  $schema?: string;
  /** OpenCode 1.x plugin list. */
  plugin?: string[];
  plugins?: PluginEntry[];
  provider?: {
    google?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UpdateConfigOptions {
  /** Override the config file path (for testing) */
  configPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PACKAGE_NAME = "opencode-antigravity-auth";
const PLUGIN_NAME = `${PACKAGE_NAME}@latest`;
const SCHEMA_URL = "https://opencode.ai/config.json";
const OPENCODE_JSON_FILENAME = "opencode.json";
const OPENCODE_JSONC_FILENAME = "opencode.jsonc";
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath(): string {
  const configDir = getConfigDir();
  const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  return jsonPath;
}

// =============================================================================
// Main Function
// =============================================================================

function isOurPackage(spec: string): boolean {
  return spec.includes(PACKAGE_NAME);
}

function entryPackage(entry: PluginEntry): string {
  return typeof entry === "string" ? entry : entry.package;
}

function parseConfig(content: string): OpencodeConfig {
  const errors: ParseError[] = [];
  const config = parse(content, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`Invalid JSON (${printParseErrorCode(first.error)} at offset ${first.offset})`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("The config file does not contain a JSON object");
  }
  return config as OpencodeConfig;
}

/**
 * Updates the opencode configuration file for this plugin on OpenCode V2.
 *
 * 1. Ensures `plugins` registers this package, moving a 1.x `plugin` entry
 *    (and its version) over instead of adding a second copy
 * 2. Removes copies of the plugin's model definitions from
 *    `provider.google.models`; the plugin registers its models at runtime on V2
 * 3. Adds `$schema` when missing
 *
 * Everything else (other plugins, providers, the user's own google models,
 * comments) is left as it is.
 */
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      const config: OpencodeConfig = { $schema: SCHEMA_URL, plugins: [{ package: PLUGIN_NAME }] };
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      return { success: true, configPath };
    }

    let text = readFileSync(configPath, "utf-8");
    const config = parseConfig(text);
    const edit = (path: Array<string | number>, value: unknown, arrayInsert = false) => {
      text = applyEdits(text, modify(text, path, value, { ...FORMATTING, isArrayInsertion: arrayInsert }));
    };

    if (!config.$schema) {
      edit(["$schema"], SCHEMA_URL);
    }

    // Take our entry out of the 1.x list, remembering its version
    let legacySpec: string | undefined;
    if (Array.isArray(config.plugin)) {
      legacySpec = config.plugin.find(isOurPackage);
      if (legacySpec) {
        const remaining = config.plugin.filter((spec) => !isOurPackage(spec));
        edit(["plugin"], remaining.length > 0 ? remaining : undefined);
      }
    }

    // Ensure plugins registers our package (any version)
    const entry = { package: legacySpec ?? PLUGIN_NAME };
    if (!Array.isArray(config.plugins)) {
      edit(["plugins"], [entry]);
    } else if (!config.plugins.some((plugin) => isOurPackage(entryPackage(plugin)))) {
      edit(["plugins", config.plugins.length], entry, true);
    }

    // Drop copies of our model definitions that the 1.x installer wrote
    const models = config.provider?.google?.models;
    if (models && typeof models === "object") {
      const copies = Object.keys(models).filter((id) => id in OPENCODE_MODEL_DEFINITIONS);
      if (copies.length > 0 && copies.length === Object.keys(models).length) {
        edit(["provider", "google", "models"], undefined);
      } else {
        for (const id of copies) {
          edit(["provider", "google", "models", id], undefined);
        }
      }
    }

    writeFileSync(configPath, text, "utf-8");
    return { success: true, configPath };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
