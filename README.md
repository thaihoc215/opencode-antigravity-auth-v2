# Antigravity + Gemini CLI OAuth Plugin for Opencode

> **OpenCode V2 plugin.** Version 2.x targets the OpenCode V2 plugin API (`@opencode/plugin`, tested with OpenCode 2.0.28). OpenCode 1.x users should stay on the 1.x releases of this package.

[![npm version](https://img.shields.io/npm/v/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm beta](https://img.shields.io/npm/v/opencode-antigravity-auth/beta.svg?label=beta)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![npm downloads](https://img.shields.io/npm/dw/opencode-antigravity-auth.svg)](https://www.npmjs.com/package/opencode-antigravity-auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![X (Twitter)](https://img.shields.io/badge/X-@dopesalmon-000000?style=flat&logo=x)](https://x.com/dopesalmon)

Enable Opencode to authenticate against **Antigravity** (Google's IDE) via OAuth so you can use Antigravity rate limits and access models like `gemini-3.1-pro` and `claude-opus-4-6-thinking` with your Google credentials.

## What You Get

- **Claude Opus 4.6, Sonnet 4.6** and **Gemini 3.1 Pro/Flash** via Google OAuth
- **Multi-account support** — add multiple Google accounts, auto-rotates when rate-limited
- **Modern Gemini API support** — use Antigravity SDK-style API keys / Cloud Projects as Gemini backups or opt-in primary routing
- **Legacy Gemini CLI quota support** — still available for compatibility and quota fallback
- **Thinking models** — extended thinking for Claude and Gemini 3 with configurable budgets
- **Google Search grounding** — enable web search for Gemini models (auto or always-on)
- **Auto-recovery** — handles session errors and tool failures automatically
- **Plugin compatible** — works alongside other OpenCode plugins (oh-my-opencode, dcp, etc.)

---

<details open>
<summary><b>⚠️ Terms of Service Warning — Read Before Installing</b></summary>

> [!CAUTION]
> Using this plugin (and any proxy for Antigravity) violates Google's Terms of Service. A number of users have reported their Google accounts being **banned** or **shadow-banned** (restricted access without explicit notification).
>
> **By using this plugin, you acknowledge:**
> - This is an unofficial tool not endorsed by Google
> - Your account may be suspended or permanently banned
> - You assume all risks associated with using this plugin
>

</details>

---

## Installation

<details open>
<summary><b>For Humans</b></summary>

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-antigravity-auth plugin and add the Antigravity model definitions to ~/.config/opencode/opencode.json by following: https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/dev/README.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json` (V2 uses the `plugins` key with object entries):

   ```json
   {
     "plugins": [{ "package": "opencode-antigravity-auth@latest" }]
   }
   ```

   Plugin options go in the same entry and override `antigravity.json`: `{ "package": "opencode-antigravity-auth@latest", "options": { "debug": true } }`.

2. **Login** with your Google account:

   ```bash
   opencode auth login google --method antigravity
   ```

   The signed-in account is added to the account pool. To add more accounts, check quotas, or enable/disable/delete accounts, use the [account manager CLI](#multi-account-setup).

3. **Models** are registered by the plugin at runtime — no `provider.google.models` block is needed.

4. **Use it** (variants use the `#variant` suffix in V2):

   ```bash
   opencode run "Hello" -m google/antigravity-claude-opus-4-6-thinking#max
   ```

</details>

<details>
<summary><b>For LLM Agents</b></summary>

### Step-by-Step Instructions

1. Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`
   
   > **Note**: This path works on all platforms. On Windows, `~` resolves to your user home directory (e.g., `C:\Users\YourName`).

2. Add `{ "package": "opencode-antigravity-auth@latest" }` to the `plugins` array (create it if missing; keep existing entries)

3. Do not add model definitions — the plugin registers the Google models itself

4. Ask the user to run `opencode auth login google --method antigravity`

### Verification

```bash
opencode run "Hello" -m google/antigravity-claude-opus-4-6-thinking#max
```

</details>

---

## Local Development / Install From Source

Use this setup when you want OpenCode to load a local checkout instead of the published npm package.

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer
- OpenCode installed and available as `opencode`

### 1. Clone and install

```bash
git clone https://github.com/NoeFabris/opencode-antigravity-auth.git
cd opencode-antigravity-auth
npm install
npm run build
```

### 2. Configure OpenCode

Add the checkout **directory** to the `plugins` array in `~/.config/opencode/opencode.json`. OpenCode V2 requires a directory (a path to a `.js` file is rejected) and loads the checkout's `index.ts` source directly.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "C:/path/to/opencode-antigravity-auth" }]
}
```

Use either the local path or `opencode-antigravity-auth@latest`, not both, to avoid loading two copies of the plugin. Preserve any other plugins and configuration already present in the file.

### 3. Restart and authenticate

Restart OpenCode (and its background service: `opencode service`), then run:

```bash
opencode auth login google --method antigravity
```

### 4. Verify the setup

```bash
opencode models
opencode run "Hello" -m google/antigravity-gemini-3.8-flash#low
```

### Rebuild after local changes

After pulling updates or editing the source, rebuild and restart OpenCode so it loads the new output:

```bash
npm install  # Only needed when dependencies change
npm run build
```

If OpenCode still behaves like an older build, see [Behavior doesn't match the version you just installed/built](docs/TROUBLESHOOTING.md#behavior-doesnt-match-the-version-you-just-installedbuilt).

---

## Models

### Model Reference

**Antigravity quota** (default routing for Claude and Gemini):

| Model | Variants | Notes |
|-------|----------|-------|
| `antigravity-gemini-3.1-pro` | low, high | Gemini 3.1 Pro with thinking (rollout-dependent) |
| `antigravity-gemini-3.8-flash` | low, medium, high | Gemini 3.8 Flash — defaults to `high` (not `low` like Pro); video/audio input |
| `antigravity-claude-sonnet-4-6` | — | Claude Sonnet 4.6 |
| `antigravity-claude-opus-4-6-thinking` | low, max | Claude Opus 4.6 with extended thinking |

**Antigravity SDK / Gemini API projects** (API-key backed; used by API-key auth, or as OAuth fallback when configured):

The official Antigravity SDK uses `GEMINI_API_KEY` for local Gemini access. This plugin now supports that path directly for Gemini models while keeping OAuth accounts for Antigravity and Claude.

**Legacy Gemini CLI quota** (separate from Antigravity; used when `cli_first` is true or as fallback):

| Model | Notes |
|-------|-------|
| `gemini-3.8-flash` | Gemini 3.8 Flash (variants: low, medium, high; defaults to high) |
| `gemini-3.1-pro` | Gemini 3.1 Pro |
| `gemini-3.1-pro-preview-customtools` | Gemini 3.1 Pro Preview Custom Tools |

> **Routing Behavior:**
> - **OAuth Antigravity-first (default):** Gemini models use Antigravity quota across OAuth accounts.
> - **Antigravity SDK / Gemini API:** API-key auth, `GEMINI_API_KEY`, or configured `agy_sdk.cloud_projects` route Gemini requests through the public Gemini API.
> - **Legacy CLI-first (`cli_first: true`):** Gemini models use the legacy Gemini CLI quota first.
> - When OAuth quota pools are exhausted, configured `agy_sdk.cloud_projects` are used as backup capacity before failing if `agy_sdk.enabled: true`, `agy_sdk.api_key_fallback: true`, and usable API-key credentials are present.
> - Claude and image models always use Antigravity.
> Model names are automatically transformed for the target API (e.g., `antigravity-gemini-3-flash` → `gemini-3-flash-preview` for CLI).

**Using variants:**
```bash
opencode run "Hello" -m google/antigravity-claude-opus-4-6-thinking#max
```

For details on variant configuration and thinking levels, see [docs/MODEL-VARIANTS.md](docs/MODEL-VARIANTS.md).

> **No static model config in V2:** the plugin registers these models (plus any discovered from your accounts) on the `google` provider at runtime. Remove an old `provider.google.models` block copied from the 1.x README; it is not needed. Legacy model names with the `antigravity-` prefix still work.

---

## Multi-Account Setup

Add multiple Google accounts for a higher combined quota. The plugin automatically rotates between accounts when one is rate-limited. Accounts live in a pool file (`antigravity-accounts.json`) owned by the plugin.

### Sign in

```bash
opencode auth login google --method antigravity
```

Before the browser opens, an **Action** question lists:

| Choice | What it does |
|--------|--------------|
| **Add a new account** (default) | Adds the account you sign in with to the pool. Existing accounts are kept; signing in with an email already in the pool refreshes that entry instead of adding a duplicate. |
| **Re-authenticate `<email>`** | One per pool account. The Google sign-in page pre-selects that email; the entry gets a fresh token and its rate-limit / verification state is cleared. Signing in with a different Google account is rejected and nothing changes. |

Non-interactive: `opencode auth login google --method antigravity --answer action=add` (or `action=reauth:<n>`, where `n` is the 0-based position in the pool).

### Manage accounts: the account manager CLI

OpenCode V2 runs plugins inside its server, so deleting accounts, enabling/disabling them and checking quotas is a separate command (requires [Bun](https://bun.sh), the runtime OpenCode itself uses). The Action question's description shows the exact command for your install.

```bash
bunx opencode-antigravity-auth            # installed from npm
bun <checkout>/src/v2/cli.ts              # local checkout
```

Add `--no-browser` on headless machines and `--help` for the full list. The menu offers:

- **Add account** — sign in more accounts in a row
- **Check quotas** — remaining quota for every account
- **Verify one / all accounts** — check that accounts still have access
- **Register plugin in opencode.json** — write the V2 `plugins` entry
- **Select an account** → *Verify account access*, *Enable/Disable account* (stays in the pool, skipped during rotation), *Refresh token*, *Delete this account*
- **Delete all accounts**

A running server applies enable/disable, verification and deletions the next time it saves the pool (on its next request at the latest). New accounts load when it restarts: `opencode service restart`.

### Log out completely

1. CLI → **Delete all accounts** (empties the pool and records the deleted accounts, so a running server cannot write them back)
2. `opencode auth logout` — removes OpenCode's own copy of the last sign-in, which otherwise keeps the google provider connected

Deleting a single account with the CLI is enough on its own: the pool file is authoritative.

For details on load balancing, dual quota pools, and account storage, see [docs/MULTI-ACCOUNT.md](docs/MULTI-ACCOUNT.md).

---

## Troubleshooting

> **Quick Reset**: Most issues can be resolved by deleting `~/.config/opencode/antigravity-accounts.json` and running `opencode auth login google --method antigravity` again.

### Configuration Path (All Platforms)

OpenCode uses `~/.config/opencode/` on **all platforms** including Windows.

| File | Path |
|------|------|
| Main config | `~/.config/opencode/opencode.json` |
| Accounts | `~/.config/opencode/antigravity-accounts.json` |
| Plugin config | `~/.config/opencode/antigravity.json` |
| Debug logs | `~/.config/opencode/antigravity-logs/` |

> **Windows users**: `~` resolves to your user home directory (e.g., `C:\Users\YourName`). Do NOT use `%APPDATA%`.

> **Custom path**: Set `OPENCODE_CONFIG_DIR` environment variable to use a custom location.

> **Windows migration**: If upgrading from plugin v1.3.x or earlier, the plugin will automatically find your existing config in `%APPDATA%\opencode\` and use it. New installations use `~/.config/opencode/`.

---

### Multi-Account Auth Issues

If you encounter authentication issues with multiple accounts:

1. Delete the accounts file:
   ```bash
   rm ~/.config/opencode/antigravity-accounts.json
   ```
2. Re-authenticate:
   ```bash
   opencode auth login google --method antigravity
   ```

---

### 403 Permission Denied (`rising-fact-p41fc`)

**Error:**
```
Permission 'cloudaicompanion.companions.generateChat' denied on resource 
'//cloudaicompanion.googleapis.com/projects/rising-fact-p41fc/locations/global'
```

**Cause:** Plugin falls back to a default project ID when no valid project is found. This works for Antigravity but fails for Gemini CLI models.

**Solution:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Gemini for Google Cloud API** (`cloudaicompanion.googleapis.com`)
4. Add `projectId` to your accounts file:
   ```json
   {
     "accounts": [
       {
         "email": "your@email.com",
         "refreshToken": "...",
         "projectId": "your-project-id"
       }
     ]
   }
   ```

> **Note**: Do this for each account in a multi-account setup.

---

### Gemini Model Not Found

Use an id from `opencode models google`. The plugin points the `google` provider at its own AI SDK module and registers the models itself, so no `npm` override or model list is needed in `opencode.json`. Removed families (Gemini 2.5, 3 Pro/Flash, 3.1 Flash, 3.5–3.7 Flash) are not offered.

---

### Gemini 3 Models 400 Error ("Unknown name 'parameters'")

**Error:**
```
Invalid JSON payload received. Unknown name "parameters" at 'request.tools[0]'
```

**Causes:**
- Tool schema incompatibility with Gemini's strict protobuf validation
- MCP servers with malformed schemas
- Plugin version regression

**Solutions:**
1. **Update to latest beta:**
   ```json
   { "plugins": [{ "package": "opencode-antigravity-auth@beta" }] }
   ```

2. **Disable MCP servers** one-by-one to find the problematic one

---

### MCP Servers Causing Errors

Some MCP servers have schemas incompatible with Antigravity's strict JSON format.

**Common symptom:**
```bash
Invalid function name must start with a letter or underscore
```

Sometimes it shows up as:
```bash
GenerateContentRequest.tools[0].function_declarations[12].name: Invalid function name must start with a letter or underscore
```

This usually means an MCP tool name starts with a number (for example, a 1mcp key like `1mcp_*`). Rename the MCP key to start with a letter (e.g., `gw`) or disable that MCP entry for Antigravity models.

**Diagnosis:**
1. Disable all MCP servers in your config
2. Enable one-by-one until error reappears
3. Report the specific MCP in a [GitHub issue](https://github.com/NoeFabris/opencode-antigravity-auth/issues)

---

### "All Accounts Rate-Limited" (But Quota Available)

**Cause:** Cascade bug in `clearExpiredRateLimits()` in hybrid mode (fixed in recent beta).

**Solutions:**
1. Update to latest beta version
2. If persists, delete accounts file and re-authenticate
3. Try switching `account_selection_strategy` to `"sticky"` in `antigravity.json`

---

### Session Recovery

> The automatic session-recovery hook was removed in 2.0: it read OpenCode 1.x on-disk session storage, which V2 does not use. Request-level thinking recovery still works.

If you encounter errors during a session:
1. Retry the operation
2. If blocked, use `/undo` to revert to pre-error state

---

### Using with Oh-My-OpenCode

**Important:** Disable the built-in Google auth to prevent conflicts:

```json
// ~/.config/opencode/oh-my-opencode.json
{
  "google_auth": false,
  "agents": {
    "frontend-ui-ux-engineer": { "model": "google/antigravity-gemini-3-pro" },
    "document-writer": { "model": "google/antigravity-gemini-3-flash" }
  }
}
```

---

### Infinite `.tmp` Files Created

**Cause:** When account is rate-limited and plugin retries infinitely, it creates many temp files.

**Workaround:**
1. Stop OpenCode
2. Clean up: `rm ~/.config/opencode/*.tmp`
3. Add more accounts or wait for rate limit to expire

---

### OAuth Callback Issues

<details>
<summary><b>Safari OAuth Callback Fails (macOS)</b></summary>

**Symptoms:**
- "fail to authorize" after successful Google login
- Safari shows "Safari can't open the page"

**Cause:** Safari's "HTTPS-Only Mode" blocks `http://localhost` callback.

**Solutions:**

1. **Use Chrome or Firefox** (easiest):
   Copy the OAuth URL and paste into a different browser.

2. **Disable HTTPS-Only Mode temporarily:**
   - Safari > Settings (⌘,) > Privacy
   - Uncheck "Enable HTTPS-Only Mode"
   - Run `opencode auth login google --method antigravity`
   - Re-enable after authentication

</details>

<details>
<summary><b>Port Conflict (Address Already in Use)</b></summary>

**macOS / Linux:**
```bash
# Find process using the port
lsof -i :51121

# Kill if stale
kill -9 <PID>

# Retry
opencode auth login google --method antigravity
```

**Windows (PowerShell):**
```powershell
netstat -ano | findstr :51121
taskkill /PID <PID> /F
opencode auth login google --method antigravity
```

</details>

<details>
<summary><b>Docker / WSL2 / Remote Development</b></summary>

OAuth callback requires browser to reach `localhost` on the machine running OpenCode.

**WSL2:**
- Use VS Code's port forwarding, or
- Configure Windows → WSL port forwarding

**SSH / Remote:**
```bash
ssh -L 51121:localhost:51121 user@remote
```

**Docker / Containers:**
- OAuth with localhost redirect doesn't work in containers
- Wait 30s for manual URL flow, or use SSH port forwarding

</details>

---

### Configuration Key: `plugins` (V2)

OpenCode V2 uses `plugins` (plural) with object entries:

```json
{
  "plugins": [{ "package": "opencode-antigravity-auth@latest" }]
}
```

Do not list this version under the 1.x `"plugin": [...]` key; it is a V2 plugin and is only tested through `plugins`.

---

### Migrating Accounts Between Machines

When copying `antigravity-accounts.json` to a new machine:
1. Ensure the plugin is installed: `"plugins": [{ "package": "opencode-antigravity-auth@latest" }]`
2. Copy `~/.config/opencode/antigravity-accounts.json`
3. If you get "API key missing" error, the refresh token may be invalid — re-authenticate

## Known Plugin Interactions
For details on load balancing, dual quota pools, and account storage, see [docs/MULTI-ACCOUNT.md](docs/MULTI-ACCOUNT.md).

---

## Plugin Compatibility

### @tarquinen/opencode-dcp

DCP creates synthetic assistant messages that lack thinking blocks. **List this plugin BEFORE DCP:**

```json
{
  "plugins": [
    { "package": "opencode-antigravity-auth@latest" },
    { "package": "@tarquinen/opencode-dcp@latest" }
  ]
}
```

### oh-my-opencode

Disable built-in auth and override agent models in `oh-my-opencode.json`:

```json
{
  "google_auth": false,
  "agents": {
    "frontend-ui-ux-engineer": { "model": "google/antigravity-gemini-3-pro" },
    "document-writer": { "model": "google/antigravity-gemini-3-flash" },
    "multimodal-looker": { "model": "google/antigravity-gemini-3-flash" }
  }
}
```

> **Tip:** When spawning parallel subagents, enable `pid_offset_enabled: true` in `antigravity.json` to distribute sessions across accounts.

### Plugins you don't need

- **gemini-auth plugins** — Not needed. This plugin handles all Google OAuth.

---

## Configuration

Create `~/.config/opencode/antigravity.json` for optional settings:

```json
{
  "$schema": "https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/assets/antigravity.schema.json"
}
```

Most users don't need to configure anything — defaults work well.

### Model Behavior

| Option | Default | What it does |
|--------|---------|--------------
| `cli_first` | `false` | Route Gemini models to the legacy Gemini CLI path first (Claude and image models stay on Antigravity). |
| `agy_sdk.enabled` | `true` | Enables the Antigravity SDK / Gemini API key route for Gemini requests. |
| `agy_sdk.prefer_for_gemini` | `false` | When API keys are configured, use the Gemini API route before OAuth-backed Antigravity for Gemini models. |
| `agy_sdk.api_key_fallback` | `true` | Use configured API keys / Cloud Projects when OAuth Antigravity and legacy Gemini CLI quotas are unavailable. |
| `model_discovery.enabled` | `true` | Load provider models dynamically from Gemini API / Antigravity model APIs, with bundled static definitions as fallback. |

### Antigravity SDK / Gemini API keys

The official Antigravity SDK quickstart uses `GEMINI_API_KEY`. You can provide one key via environment variable:

```bash
GEMINI_API_KEY=your-key opencode run "Hello" --model=google/gemini-3-pro
```

For multiple Cloud Projects / API keys, add them to `~/.config/opencode/antigravity.json`:

```json
{
  "agy_sdk": {
    "api_key_fallback": true,
    "prefer_for_gemini": false,
    "cloud_projects": [
      { "label": "primary", "project_id": "my-project", "api_key": "..." },
      { "label": "backup", "project_id": "my-backup-project", "api_key": "..." }
    ]
  }
}
```

Keep this file private: API keys are stored in your local OpenCode config and are sent to Gemini with the `x-goog-api-key` header, never in the request URL. Do not commit `antigravity.json` with real keys.

Set `prefer_for_gemini: true` if you want Gemini models to use the newer Gemini API path before OAuth-backed Antigravity. OAuth multi-account rotation remains active for Antigravity/Claude and as fallback when `prefer_for_gemini` keys are unavailable. `cli_first` remains the legacy Gemini CLI compatibility mode.

### Account Rotation

| Your Setup | Recommended Config |
|------------|-------------------|
| **1 account** | `"account_selection_strategy": "sticky"` |
| **2-5 accounts** | Default (`"hybrid"`) works great |
| **5+ accounts** | `"account_selection_strategy": "round-robin"` |
| **Parallel agents** | Add `"pid_offset_enabled": true` |

### Quota Protection

| Option | Default | What it does |
|--------|---------|--------------|
| `soft_quota_threshold_percent` | `90` | Skip account when quota usage exceeds this percentage. Prevents Google from penalizing accounts that fully exhaust quota. Set to `100` to disable. |
| `quota_refresh_interval_minutes` | `15` | Background quota refresh interval. After successful API requests, refreshes quota cache if older than this interval. Set to `0` to disable. |
| `soft_quota_cache_ttl_minutes` | `"auto"` | How long quota cache is considered fresh. `"auto"` = max(2 × refresh interval, 10 minutes). Set a number (1-120) for fixed TTL. |

> **How it works**: Quota cache is refreshed automatically after API requests (when older than `quota_refresh_interval_minutes`) and manually via **Check quotas** in the account manager CLI (`bunx opencode-antigravity-auth`).The threshold check uses `soft_quota_cache_ttl_minutes` to determine cache freshness - if cache is older, the account is considered "unknown" and allowed (fail-open). When ALL accounts exceed the threshold, the plugin waits for the earliest quota reset time (like rate limit behavior). If wait time exceeds `max_rate_limit_wait_seconds`, it errors immediately.

### Rate Limit Scheduling

Control how the plugin handles rate limits:

| Option | Default | What it does |
|--------|---------|--------------|
| `scheduling_mode` | `"cache_first"` | `"cache_first"` = wait for same account (preserves prompt cache), `"balance"` = switch immediately, `"performance_first"` = round-robin |
| `max_cache_first_wait_seconds` | `60` | Max seconds to wait in cache_first mode before switching accounts |
| `failure_ttl_seconds` | `3600` | Reset failure count after this many seconds (prevents old failures from permanently penalizing accounts) |

**When to use each mode:**
- **cache_first** (default): Best for long conversations. Waits for the same account to recover, preserving your prompt cache.
- **balance**: Best for quick tasks. Switches accounts immediately when rate-limited for maximum availability.
- **performance_first**: Best for many short requests. Distributes load evenly across all accounts.

### App Behavior

| Option | Default | What it does |
|--------|---------|--------------|
| `debug` | `false` | Enable debug file logging (`~/.config/opencode/antigravity-logs/`) |
| `debug_tui` | `false` | Add the request's debug lines to the model's thinking output and error messages (independent from `debug`) |

For all options, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

**Environment variables:**
```bash
OPENCODE_CONFIG_DIR=/path/to/config opencode  # Custom config directory
OPENCODE_ANTIGRAVITY_DEBUG=1 opencode         # Enable debug file logging
OPENCODE_ANTIGRAVITY_DEBUG=2 opencode         # Verbose debug file logging
OPENCODE_ANTIGRAVITY_DEBUG_TUI=1 opencode     # Add debug lines to thinking output
```

---

## Troubleshooting

See the full [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for solutions to common issues including:

- Auth problems and token refresh
- "Model not found" errors
- Session recovery
- Gemini CLI permission errors
- Safari OAuth issues
- Plugin compatibility
- Migration guides

---

## Documentation

- [Configuration](docs/CONFIGURATION.md) — All configuration options
- [Multi-Account](docs/MULTI-ACCOUNT.md) — Load balancing, dual quota pools, account storage
- [Model Variants](docs/MODEL-VARIANTS.md) — Thinking budgets and variant system
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and fixes
- [Architecture](docs/ARCHITECTURE.md) — How the plugin works
- [API Spec](docs/ANTIGRAVITY_API_SPEC.md) — Antigravity API reference

---

## Support

If this plugin saves you time, consider supporting its development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S81QBOIR)

---

## Credits

- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

## License

MIT License. See [LICENSE](LICENSE) for details.

<details>
<summary><b>Legal</b></summary>

### Intended Use

- Personal / internal development only
- Respect internal quotas and data handling policies
- Not for production services or bypassing intended limits

### Warning

By using this plugin, you acknowledge:

- **Terms of Service risk** — This approach may violate ToS of AI model providers
- **Account risk** — Providers may suspend or ban accounts
- **No guarantees** — APIs may change without notice
- **Assumption of risk** — You assume all legal, financial, and technical risks

### Disclaimer

- Not affiliated with Google. This is an independent open-source project.
- "Antigravity", "Gemini", "Google Cloud", and "Google" are trademarks of Google LLC.

</details>
