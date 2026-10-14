/**
 * Structured Logger for Antigravity Plugin
 *
 * Logging behavior:
 * - debug controls file logs only (via debug.ts)
 * - OPENCODE_ANTIGRAVITY_CONSOLE_LOG=1 → console output (independent of debug flags)
 *
 * OpenCode V2 gives plugins no log panel API, so there is no TUI sink.
 */

import {
  isTruthyFlag,
  writeConsoleLog,
} from "./logging-utils";

type LogLevel = "debug" | "info" | "warn" | "error";

const ENV_CONSOLE_LOG = "OPENCODE_ANTIGRAVITY_CONSOLE_LOG";

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * Check if console logging is enabled via environment variable.
 */
function isConsoleLogEnabled(): boolean {
  return isTruthyFlag(process.env[ENV_CONSOLE_LOG]);
}

/**
 * Create a logger instance for a specific module.
 *
 * @param module - The module name (e.g., "refresh-queue", "transform.claude")
 * @returns Logger instance with debug, info, warn, error methods
 *
 * @example
 * ```typescript
 * const log = createLogger("refresh-queue");
 * log.debug("Checking tokens", { count: 5 });
 * log.warn("Token expired", { accountIndex: 0 });
 * ```
 */
export function createLogger(module: string): Logger {
  const service = `antigravity.${module}`;

  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    if (isConsoleLogEnabled()) {
      const prefix = `[${service}]`;
      const args = extra ? [prefix, message, extra] : [prefix, message];
      writeConsoleLog(level, ...args);
    }
  };

  return {
    debug: (message, extra) => log("debug", message, extra),
    info: (message, extra) => log("info", message, extra),
    warn: (message, extra) => log("warn", message, extra),
    error: (message, extra) => log("error", message, extra),
  };
}
