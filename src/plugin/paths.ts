import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The OpenCode config directory, where the plugin keeps its files (account
 * pool, antigravity.json, signature cache, debug logs):
 * 1. OPENCODE_CONFIG_DIR, when set
 * 2. $XDG_CONFIG_HOME/opencode
 * 3. ~/.config/opencode (all platforms, including Windows)
 *
 * These follow the environment of the process, so an OpenCode background
 * service started with different variables than your shell reads another
 * directory. The account manager CLI prints the pool path it uses.
 */
export function getConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/** %APPDATA%\opencode, used by older plugin versions on Windows. */
export function getLegacyWindowsConfigDir(): string {
  return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
}
