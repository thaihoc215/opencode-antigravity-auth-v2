# Architecture Guide

**Last Updated:** October 2026

This document explains how the Antigravity plugin works: request/response flow, Claude-specific handling, and error recovery.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenCode ──▶ Plugin ──▶ Antigravity API ──▶ Claude/Gemini      │
│     │           │              │                   │            │
│     │           │              │                   └─ Model     │
│     │           │              └─ Google's gateway (Gemini fmt) │
│     │           └─ THIS PLUGIN (auth, transform, recovery)      │
│     └─ AI coding assistant                                      │
└─────────────────────────────────────────────────────────────────┘
```

The plugin intercepts requests to `generativelanguage.googleapis.com`, transforms them for the Antigravity API, and handles authentication, rate limits, and error recovery.

---

## Module Structure

The plugin has three parts:

- **`src/v2/` — OpenCode V2 adapter.** The plugin entry (`{ id, setup(ctx) }`). It registers the provider, models, AI SDK, OAuth method and `google_search` tool through the V2 `ctx` APIs, reads the active credential (`host.ts`), and rebuilds the core's route when the google credential or the pool changes. The cleanup it returns stops the route and the core.
- **`src/plugin.ts` + `src/plugin/` — host-agnostic core.** `createAntigravityCore({ directory, options, getAuth, onAccountsRevoked })` returns `loader()` (an `AntigravityRoute`: the Antigravity fetch plus `dispose()`), `models()`, the `google_search` tool and `dispose()`. It never imports OpenCode APIs; the host passes `getAuth` and is told through `onAccountsRevoked` when every pool account's token was revoked. Status messages (rate-limit waits, quota fallbacks) go to the plugin log.
- **`src/cli/` — account manager CLI.** The interactive menu (`bunx opencode-antigravity-auth`, entry `src/v2/cli.ts`). It edits `antigravity-accounts.json` directly and is never loaded by the server.

```
src/
├── index.ts                 # Package entry (re-exports src/v2/plugin.ts)
├── plugin.ts                # Core: createAntigravityCore (models, google_search, lifecycle)
├── constants.ts             # Endpoints, headers, client version
├── antigravity/
│   └── oauth.ts             # OAuth URL (random state, PKCE) and token exchange
├── v2/
│   ├── plugin.ts            # OpenCode V2 plugin entry
│   ├── host.ts              # V2 ctx → core credential / revoked-account report
│   ├── models.ts            # Model definitions → V2 Model.Info
│   ├── actions.ts           # "Action" question of the OAuth form
│   ├── sdk.ts               # AI SDK factory loaded by OpenCode
│   └── cli.ts               # Account manager CLI entry
├── cli/
│   ├── account-manager.ts   # Menu actions: add, re-auth, verify, quotas, delete
│   ├── prompts.ts           # Menu prompts
│   ├── opencode-config.ts   # "Register plugin in opencode.json"
│   └── ui/                  # Terminal menu widgets
└── plugin/
    ├── router.ts            # Request routing: account selection, retries, endpoint fallback
    ├── oauth-flow.ts        # Sign-in shared by the integration and the CLI; writes the pool
    ├── verification.ts      # Google account verification (403 detection, probe)
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (main logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection, crash recovery
    ├── recovery.ts          # Recoverable error classification
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Signature caching
    ├── cache/
    │   └── signature-cache.ts # Disk-based signature persistence
    ├── config/
    │   ├── schema.ts        # Zod config schema
    │   └── loader.ts        # Config file loading
    ├── accounts.ts          # Multi-account management (in-memory pool)
    ├── storage.ts           # antigravity-accounts.json: locking, merging, tombstones
    ├── paths.ts             # Config directory resolution
    ├── server.ts            # OAuth callback server
    └── debug.ts             # Debug logging
```

---

## Request Flow

### 1. Interception (`plugin/router.ts`)

```typescript
fetch() intercepted → isGenerativeLanguageRequest() → prepareAntigravityRequest()
```

- Account selection (round-robin, rate-limit aware)
- Token refresh if expired
- Endpoint fallback (daily → autopush → prod)

### 2. Request Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| Model detection | Detect Claude/Gemini from URL |
| Thinking config | Add `thinkingConfig` for thinking models |
| Thinking strip | Remove ALL thinking blocks (Claude) |
| Tool normalization | Convert to `functionDeclarations[]` |
| Schema cleaning | Remove unsupported JSON Schema fields |
| ID assignment | Assign IDs to tool calls (FIFO matching) |
| Wrap request | `{ project, model, request: {...} }` |

### 3. Response Transformation (`request.ts`)

| Step | What Happens |
|------|--------------|
| SSE streaming | Real-time line-by-line TransformStream |
| Signature caching | Cache `thoughtSignature` for display |
| Format transform | `thought: true` → `type: "reasoning"` |
| Envelope unwrap | Extract inner `response` object |

---

## Claude-Specific Handling

### Why Special Handling?

Claude through Antigravity requires:
1. **Gemini format** - `contents[].parts[]` not `messages[].content[]`
2. **Thinking signatures** - Multi-turn needs signed blocks or errors
3. **Schema restrictions** - Rejects `const`, `$ref`, `$defs`, etc.
4. **Tool validation** - `VALIDATED` mode requires proper schemas

### Thinking Block Strategy (v2.0)

**Problem:** OpenCode stores thinking blocks, but may corrupt signatures.

**Solution:** Strip ALL thinking blocks from outgoing requests.

```
Turn 1 Response: { thought: true, text: "...", thoughtSignature: "abc" }
                 ↓ (stored by OpenCode, possibly corrupted)
Turn 2 Request:  Plugin STRIPS all thinking blocks
                 ↓
Claude API:      Generates fresh thinking
```

**Why this works:**
- Zero signature errors (impossible to have invalid signatures)
- Same quality (Claude sees full conversation, re-thinks fresh)
- Simpler code (no complex validation/restoration)

### Thinking Injection for Tool Use

Claude API requires thinking before `tool_use` blocks. The plugin:

1. Caches signed thinking from responses (`lastSignedThinkingBySessionKey`)
2. On subsequent requests, injects cached thinking before tool_use
3. Only injects for the **first** assistant message of a turn (not every message)

**Turn boundary detection** (`thinking-recovery.ts`):
```typescript
// A "turn" starts after a real user message (not tool_result)
// Only inject thinking into first assistant message after that
```

---

## Error Recovery

### Tool Result Missing Error

When a tool execution is interrupted (ESC, timeout, crash):

```
Error: tool_use ids were found without tool_result blocks immediately after
```

`detectErrorType()` (`recovery.ts`) classifies the error for the request pipeline. The 1.x plugin also repaired the session by editing OpenCode's on-disk message storage; OpenCode V2 does not use that storage, so the session-recovery hook was removed in 2.0. Retry, or `/undo` to before the interrupted tool call.

### Thinking Block Order Error

```
Error: Expected thinking but found text
```

**Recovery** (`thinking-recovery.ts`):

1. Detect conversation is in tool loop without thinking at turn start
2. Close the corrupted turn with synthetic messages
3. Start fresh turn where Claude can generate new thinking

---

## Schema Cleaning

Claude rejects unsupported JSON Schema features. The plugin uses an **allowlist approach**:

**Kept:** `type`, `properties`, `required`, `description`, `enum`, `items`

**Removed:** `const`, `$ref`, `$defs`, `default`, `examples`, `additionalProperties`, `$schema`, `title`

**Transformations:**
- `const: "value"` → `enum: ["value"]`
- Empty object schema → Add placeholder `reason` property

---

## Multi-Account Load Balancing

### How It Works

1. **Sticky selection** - Same account until rate limited (preserves cache)
2. **Per-model-family** - Claude/Gemini rate limits tracked separately
3. **Dual quota (Gemini)** - Antigravity + Gemini CLI headers
4. **Automatic failover** - On 429, switch to next available account

### Account Storage

Location: `~/.config/opencode/antigravity-accounts.json` (the directory follows `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`; the CLI prints the path it uses)

Contains OAuth refresh tokens - treat as sensitive.

The server and the account manager CLI both write the file. Writes take a file lock and merge with what is on disk:

- Rate-limit state merges per quota key by the time it was set or cleared.
- Enable/disable and verification state merges by `statusChangedAt`: the later change wins, so a server saving its in-memory pool cannot undo a CLI edit. After each save the server adopts newer status changes and stops using accounts deleted on disk.
- Deleted accounts are kept as hashed tombstones (`deletedRefreshTokenHashes`), so a stale copy cannot bring them back. "Delete all" and "start fresh" tombstone every replaced account.
- A file that cannot be read or parsed fails the write instead of being overwritten.

---

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | `1` or `2` for file debug logging |
| `OPENCODE_ANTIGRAVITY_DEBUG_TUI` | `1` or `true` to add the request's debug lines to the thinking output |

`debug` and `debug_tui` are independent: `debug` controls file logs, while `debug_tui` adds debug lines to the model's thinking output and error messages.

### Config File

Location: `~/.config/opencode/antigravity.json`

```json
{
  "keep_thinking": false,
  "debug": false
}
```

---

## Key Functions Reference

### `request.ts`

| Function | Purpose |
|----------|---------|
| `prepareAntigravityRequest()` | Main request transformation |
| `transformAntigravityResponse()` | SSE streaming, format conversion |
| `ensureThinkingBeforeToolUseInContents()` | Inject cached thinking |
| `createStreamingTransformer()` | Real-time SSE processing |

### `request-helpers.ts`

| Function | Purpose |
|----------|---------|
| `deepFilterThinkingBlocks()` | Recursive thinking block removal |
| `cleanJSONSchemaForAntigravity()` | Schema sanitization |
| `transformThinkingParts()` | `thought` → `reasoning` format |

### `thinking-recovery.ts`

| Function | Purpose |
|----------|---------|
| `analyzeConversationState()` | Detect turn boundaries, tool loops |
| `needsThinkingRecovery()` | Check if recovery needed |
| `closeToolLoopForThinking()` | Inject synthetic messages |

### `recovery.ts`

| Function | Purpose |
|----------|---------|
| `detectErrorType()` | Classify recoverable Antigravity errors |

---

## Debugging

### Enable Logging

```bash
export OPENCODE_ANTIGRAVITY_DEBUG=2      # Verbose file logs
export OPENCODE_ANTIGRAVITY_DEBUG_TUI=1  # Debug lines in thinking output
```

### Log Location

`~/.config/opencode/antigravity-logs/`

### What To Check

1. Is `isClaudeModel` true for Claude models?
2. Are thinking blocks being stripped?
3. Are tool schemas being cleaned?
4. Is thinking recovery triggering?

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid signature` | Corrupted thinking block | Update plugin (strips all thinking) |
| `Unknown field: const` | Schema uses `const` | Plugin auto-converts to `enum` |
| `tool_use without tool_result` | Interrupted execution | Retry, or `/undo` to before the tool call |
| `Expected thinking but found text` | Turn started without thinking | Thinking recovery closes turn |
| `429 Too Many Requests` | Rate limited | Plugin auto-rotates accounts |

---

## See Also

- [ANTIGRAVITY_API_SPEC.md](./ANTIGRAVITY_API_SPEC.md) - API reference
- [README.md](../README.md) - Installation & usage
