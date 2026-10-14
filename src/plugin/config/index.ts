/**
 * Configuration module for opencode-antigravity-auth plugin.
 * 
 * @example
 * ```typescript
 * import { loadConfig, type AntigravityConfig } from "./config";
 * 
 * const config = loadConfig(directory);
 * if (config.keep_thinking) {
 *   // Preserve thinking blocks
 * }
 * ```
 */

export {
  AntigravityConfigSchema,
  SignatureCacheConfigSchema,
  DEFAULT_CONFIG,
  type AntigravityConfig,
  type SignatureCacheConfig,
} from "./schema";

export {
  loadConfig,
  getUserConfigPath,
  getProjectConfigPath,
  getDefaultLogsDir,
  configExists,
  initRuntimeConfig,
  getKeepThinking,
} from "./loader";
