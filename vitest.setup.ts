// Every test run gets its own config directory, so no test can read or write
// the real ~/.config/opencode (account pool, antigravity.json, logs).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "opencode-antigravity-tests-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.APPDATA = join(root, "appdata");
delete process.env.OPENCODE_CONFIG_DIR;
