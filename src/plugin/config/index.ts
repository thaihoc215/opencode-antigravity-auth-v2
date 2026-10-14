/**
 * Configuration module for opencode-antigravity-auth plugin.
 * 
 * @example
 * ```typescript
 * import { loadConfig, type AntigravityConfig } from "./config";
 * 
 * const config = loadConfig(directory, options);
 * if (config.debug) {
 *   // ...
 * }
 * ```
 */

export {
  AntigravityConfigSchema,
  DEFAULT_CONFIG,
  type AntigravityConfig,
} from "./schema";

export {
  loadConfig,
  getUserConfigPath,
  getProjectConfigPath,
  getDefaultLogsDir,
  configExists,
} from "./loader";
