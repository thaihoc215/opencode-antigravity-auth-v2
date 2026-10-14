/**
 * Configuration loader for opencode-antigravity-auth plugin.
 * 
 * Loads config from files.
 * Priority (lowest to highest):
 * 1. Schema defaults
 * 2. User config file
 * 3. Project config file
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AntigravityConfigSchema, DEFAULT_CONFIG, type AntigravityConfig } from "./schema";
import { createLogger } from "../logger";
import { getConfigDir } from "../paths";

const log = createLogger("config");

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Get the user-level config file path.
 */
export function getUserConfigPath(): string {
  return join(getConfigDir(), "antigravity.json");
}

/**
 * Get the project-level config file path.
 */
export function getProjectConfigPath(directory: string): string {
  return join(directory, ".opencode", "antigravity.json");
}

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Load and parse a config file, returning null if not found or invalid.
 */
function loadConfigFile(path: string): Partial<AntigravityConfig> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    const content = readFileSync(path, "utf-8");
    return parsePartialConfig(JSON.parse(content), path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.warn("Invalid JSON in config file", { path, error: error.message });
    } else {
      log.warn("Failed to load config file", { path, error: String(error) });
    }
    return null;
  }
}

/** Options that were removed; a config that still sets them loads, with a warning. */
const REMOVED_OPTIONS = ["keep_thinking", "signature_cache", "quiet_mode"] as const;

/**
 * Validate a partial config object, returning null (and logging) when invalid.
 */
function parsePartialConfig(rawConfig: unknown, source: string): Partial<AntigravityConfig> | null {
  if (rawConfig && typeof rawConfig === "object") {
    const removed = REMOVED_OPTIONS.filter((key) => key in rawConfig);
    if (removed.length > 0) {
      log.warn("Ignoring removed options", { path: source, removed: removed.join(", ") });
    }
  }

  // Validate with Zod (partial - we'll merge with defaults later)
  const result = AntigravityConfigSchema.partial().safeParse(rawConfig);

  if (!result.success) {
    log.warn("Config validation error", {
      path: source,
      issues: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "),
    });
    return null;
  }

  return result.data;
}

/**
 * Options a repository's .opencode/antigravity.json may not set: debug logs
 * contain prompts and responses, so only the user decides whether and where
 * they are written.
 */
const USER_ONLY_OPTIONS = ["debug", "debug_tui", "log_dir"] as const;

function withoutUserOnlyOptions(
  config: Partial<AntigravityConfig>,
  path: string,
): Partial<AntigravityConfig> {
  const ignored = USER_ONLY_OPTIONS.filter((key) => config[key] !== undefined);
  if (ignored.length === 0) {
    return config;
  }
  log.warn("Ignoring options that only the user config may set", { path, ignored: ignored.join(", ") });
  const copy = { ...config };
  for (const key of ignored) {
    delete copy[key];
  }
  return copy;
}

/**
 * Merge two config objects, with override taking precedence.
 */
function mergeConfigs(
  base: AntigravityConfig,
  override: Partial<AntigravityConfig>
): AntigravityConfig {
  return { ...base, ...override };
}

// =============================================================================
// Main Loader
// =============================================================================

/**
 * Load the complete configuration.
 * 
 * @param directory - The project directory (for project-level config)
 * @param options - Plugin options from opencode.json `plugins[].options`; highest precedence
 * @returns Fully resolved configuration
 */
export function loadConfig(directory: string, options?: Record<string, unknown>): AntigravityConfig {
  // Start with defaults
  let config: AntigravityConfig = { ...DEFAULT_CONFIG };

  // Load user config file (if exists)
  const userConfigPath = getUserConfigPath();
  const userConfig = loadConfigFile(userConfigPath);
  if (userConfig) {
    config = mergeConfigs(config, userConfig);
  }

  // Load project config file (if exists) - overrides user config
  const projectConfigPath = getProjectConfigPath(directory);
  const projectConfig = loadConfigFile(projectConfigPath);
  if (projectConfig) {
    config = mergeConfigs(config, withoutUserOnlyOptions(projectConfig, projectConfigPath));
  }

  // Plugin options from the OpenCode config override both files
  if (options && Object.keys(options).length > 0) {
    const optionsConfig = parsePartialConfig(options, "opencode.json plugin options");
    if (optionsConfig) {
      config = mergeConfigs(config, optionsConfig);
    }
  }

  return config;
}

/**
 * Check if a config file exists at the given path.
 */
export function configExists(path: string): boolean {
  return existsSync(path);
}

/**
 * Get the default logs directory.
 */
export function getDefaultLogsDir(): string {
  return join(getConfigDir(), "antigravity-logs");
}

