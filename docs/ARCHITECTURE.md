# Architecture Guide

**Last Updated:** April 2026

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

The plugin has two layers:

- **`src/v2/` — OpenCode V2 adapter.** The plugin entry (`{ id, setup(ctx) }`). It registers the provider, models, AI SDK, OAuth method and `google_search` tool through the V2 `ctx` APIs, and maps the V2 credential and connection APIs onto the core's `PluginClient` (`host.ts`). It also ships the account manager CLI (`cli.ts`).
- **`src/plugin.ts` + `src/plugin/` — host-agnostic core.** Request transformation, account rotation, quota and OAuth. It exposes `auth.loader` (the Antigravity fetch), `auth.login` (interactive CLI login), `models()` and the `google_search` tool, and never imports OpenCode APIs directly.

```
src/
├── index.ts                 # Package entry (re-exports src/v2/plugin.ts)
├── plugin.ts                # Core: fetch interceptor, account rotation, login
├── constants.ts             # Endpoints, headers, config
├── antigravity/
│   └── oauth.ts             # OAuth token exchange
├── v2/
│   ├── plugin.ts            # OpenCode V2 plugin entry
│   ├── host.ts              # V2 ctx → core PluginClient / credential
│   ├── models.ts            # Model definitions → V2 Model.Info
│   ├── actions.ts           # "Action" question of the OAuth form
│   ├── sdk.ts               # AI SDK factory loaded by OpenCode
│   └── cli.ts               # Account manager CLI
└── plugin/
    ├── auth.ts              # Token validation & refresh
    ├── request.ts           # Request transformation (main logic)
    ├── request-helpers.ts   # Schema cleaning, thinking filters
    ├── thinking-recovery.ts # Turn boundary detection, crash recovery
    ├── recovery.ts          # Recoverable error classification
    ├── quota.ts             # Quota checking (API usage stats)
    ├── cache.ts             # Auth & signature caching
    ├── cache/
    │   └── signature-cache.ts # Disk-based signature persistence
    ├── config/
    │   ├── schema.ts        # Zod config schema
    │   └── loader.ts        # Config file loading
    ├── accounts.ts          # Multi-account management
    ├── server.ts            # OAuth callback server
    └── debug.ts             # Debug logging
```

---

## Request Flow

### 1. Interception (`plugin.ts`)

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

Location: `~/.config/opencode/antigravity-accounts.json`

Contains OAuth refresh tokens - treat as sensitive.

---

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENCODE_ANTIGRAVITY_DEBUG` | `1` or `2` for file debug logging |
| `OPENCODE_ANTIGRAVITY_DEBUG_TUI` | `1` or `true` to add the request's debug lines to the thinking output |
| `OPENCODE_ANTIGRAVITY_QUIET` | Suppress toast notifications |

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
