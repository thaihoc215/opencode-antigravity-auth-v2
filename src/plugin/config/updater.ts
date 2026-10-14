/**
 * OpenCode configuration file updater.
 *
 * Registers the plugin in ~/.config/opencode/opencode.json(c) for OpenCode V2.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS } from "./models";

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

function stripJsonCommentsAndTrailingCommas(json: string): string {
  return json
    .replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match: string, group: string | undefined) => (group ? "" : match)
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath(): string {
  const configDir = getOpencodeConfigDir();
  const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
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

/**
 * Updates the opencode configuration file for this plugin on OpenCode V2.
 *
 * This function:
 * 1. Reads existing opencode.json/opencode.jsonc (or creates default structure)
 * 2. Ensures `plugins` registers this package, moving a 1.x `plugin` entry
 *    (and its version) over instead of adding a second copy
 * 3. Removes copies of the plugin's model definitions from `provider.google.models`;
 *    the plugin registers its models at runtime on V2
 * 4. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Other plugins, in either list
 * - Non-google provider sections, google settings, and the user's own google models
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    let config: OpencodeConfig;

    // Read existing config or create default
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      config = JSON.parse(stripJsonCommentsAndTrailingCommas(content)) as OpencodeConfig;
    } else {
      config = { $schema: SCHEMA_URL };
    }

    // Ensure $schema is set
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }

    // Take our entry out of the 1.x list, remembering its version
    let legacySpec: string | undefined;
    if (Array.isArray(config.plugin)) {
      legacySpec = config.plugin.find(isOurPackage);
      config.plugin = config.plugin.filter((spec) => !isOurPackage(spec));
      if (config.plugin.length === 0) {
        delete config.plugin;
      }
    }

    // Ensure plugins registers our package (any version)
    if (!Array.isArray(config.plugins)) {
      config.plugins = [];
    }
    if (!config.plugins.some((entry) => isOurPackage(entryPackage(entry)))) {
      config.plugins.push({ package: legacySpec ?? PLUGIN_NAME });
    }

    // Drop copies of our model definitions that the 1.x installer wrote
    const google = config.provider?.google;
    if (google?.models) {
      for (const modelId of Object.keys(OPENCODE_MODEL_DEFINITIONS)) {
        delete google.models[modelId];
      }
      if (Object.keys(google.models).length === 0) {
        delete google.models;
      }
    }

    // Ensure config directory exists
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config with proper formatting (2-space indent)
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
