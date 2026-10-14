# Model Variants

OpenCode's variant system lets you configure the thinking budget dynamically without defining separate models for each thinking level.

---

## How Variants Work

The plugin registers its models with `variants`, and OpenCode shows them in the model picker. Selecting a variant passes the `providerOptions` to the plugin, which extracts the thinking configuration. On OpenCode V2 a variant is selected with a `#variant` suffix:

```bash
opencode run "Hello" -m google/antigravity-claude-opus-4-6-thinking#max
```

> **OpenCode V2:** the JSON examples below show each model's variant definitions in the 1.x config format. On V2 the plugin registers them itself (a `thinkingLevel` variant becomes Google provider options `{ "thinkingConfig": { "thinkingLevel": ... } }`), so you do not need to copy them into `opencode.json`.

---

## Variant Configuration

Define variants in your model configuration:

```json
{
  "antigravity-claude-opus-4-6-thinking": {
    "name": "Claude Opus 4.6 Thinking",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

---

## Supported Variant Formats

The plugin accepts different variant formats depending on the model family:

| Model Family | Variant Format | Example |
|--------------|----------------|---------|
| **Claude** | `thinkingConfig.thinkingBudget` | `{ "thinkingConfig": { "thinkingBudget": 8192 } }` |
| **Gemini 3** | `thinkingLevel` | `{ "thinkingLevel": "high" }` |
| **Gemini 2.5** | `thinkingConfig.thinkingBudget` | `{ "thinkingConfig": { "thinkingBudget": 8192 } }` |

---

## Gemini 3 Thinking Levels

Gemini 3 models use string-based thinking levels. Available levels differ by model:

| Level | Flash | 3.6 Flash | 3.7 Flash | 3.8 Flash | Pro | Description |
|-------|-------|-----------|-----------|-----------|-----|-------------|
| `minimal` | ✅ | ❌ | ❌ | ❌ | ❌ | Minimal thinking, lowest latency |
| `low` | ✅ | ✅ | ✅ | ✅ | ✅ | Light thinking |
| `medium` | ✅ | ✅ | ✅ | ✅ | ❌ | Balanced thinking |
| `high` | ✅ | ✅ | ✅ | ✅ | ✅ | Maximum thinking |

Default when no tier is requested: `low`, except **3.7 and 3.8 Flash, which default to
`high`**. This is a deliberate deviation — Google documents `medium` as 3.7's own
default, and every other model here defaults to `low`. An untiered 3.7 selection
therefore costs more per request than its siblings; pick `low` or `medium`
explicitly if that matters to you.

> **Gemini 3.7 requires an Antigravity client version >= 2.5.2.** The backend
> gates its catalog on the version in the User-Agent — a client reporting an
> older version is simply not served the `gemini-3.7-flash-*` ids. The plugin
> floors its reported version at the latest release, so this is handled
> automatically; it only matters if you override the version yourself.

> **Note:** The API rejects invalid levels (e.g., `"minimal"` on Pro). Configure variants accordingly.
> Gemini 3.6, 3.7 and 3.8 Flash serve only `low`/`medium`/`high`; a requested `minimal` is folded down to `low`.

### Output token budget

OpenCode caps every request at `Math.min(model.limit.output, 32000)`. Declaring a
higher `limit.output` in your config does **not** raise it — the cap is applied
after the provider hook, so 65536 and 32000 send the same request.

The plugin restores the real budget for Gemini before the request leaves:

| Model line | Restored `maxOutputTokens` |
|---|---|
| Gemini 3 Flash (3-flash, 3.5, 3.6, 3.7, 3.8) | 65536 |
| Gemini 3 Pro (3.1 Pro, `gemini-pro-agent`) | 65535 |
| Gemini 3.1 Flash Lite, Gemini 2.5 family | 65535 |
| Image models, Claude, non-Gemini | untouched |

Only a budget equal to the cap exactly is rewritten, so setting a deliberately
small `maxOutputTokens` still works.

### Gemini 3.7 Flash: sampling parameters

`temperature`, `topP` and `topK` are accepted and forwarded unchanged, exactly as
for 3.6. Probed 2026-09-05 against `v1internal:generateContent`:
`gemini-3.7-flash-high` returns 200 for a payload carrying all three.

Google's guidance is to leave `temperature` at its default of `1.0` for all
Gemini 3 models — lower values "may lead to unexpected behavior, such as looping
or degraded performance" — but that is advice, not a rejected field. Prefer
`thinkingLevel` for controlling 3.7's behaviour.

### Gemini 3.6 Flash Example

Gemini 3.6 Flash carries the effort level in the Antigravity backend id itself
(`gemini-3.6-flash-low` / `-medium` / `-high`), unlike 3.5 Flash where `low` and
`medium` share one backend id and `high` maps to `gemini-3-flash-agent`. The
resolver handles that translation — configure it with plain variants:

```json
{
  "antigravity-gemini-3.6-flash": {
    "name": "Gemini 3.6 Flash (Antigravity)",
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

### Gemini 3.7 Flash Example

3.7 Flash follows the same effort-in-the-id scheme as 3.6
(`gemini-3.7-flash-low` / `-medium` / `-high`), and additionally accepts video and
audio input:

```json
{
  "antigravity-gemini-3.7-flash": {
    "name": "Gemini 3.7 Flash (Antigravity)",
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": {
      "input": ["text", "image", "pdf", "video", "audio"],
      "output": ["text"]
    },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

### Gemini 3.8 Flash Example

3.8 Flash matches 3.7: backend ids `gemini-3.8-flash-low` / `-medium` / `-high`,
default `high`, context 1048576, output 65536, and video/audio input (Antigravity
catalog, 2026-10-14). The catalog also lists `gemini-3.8-flash-tiered`, which the
plugin does not expose. There is no 3.8 Flash Lite in the catalog.

```json
{
  "antigravity-gemini-3.8-flash": {
    "name": "Gemini 3.8 Flash (Antigravity)",
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": {
      "input": ["text", "image", "pdf", "video", "audio"],
      "output": ["text"]
    },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

### Gemini 3 Pro Example

```json
{
  "antigravity-gemini-3-pro": {
    "name": "Gemini 3 Pro (Antigravity)",
    "limit": { "context": 1048576, "output": 65535 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingLevel": "low" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

### Gemini 3 Flash Example

```json
{
  "antigravity-gemini-3-flash": {
    "name": "Gemini 3 Flash (Antigravity)",
    "limit": { "context": 1048576, "output": 65536 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "minimal": { "thinkingLevel": "minimal" },
      "low": { "thinkingLevel": "low" },
      "medium": { "thinkingLevel": "medium" },
      "high": { "thinkingLevel": "high" }
    }
  }
}
```

---

## Claude Thinking Budget

Claude models use token-based thinking budgets (in tokens):

| Variant | Budget | Description |
|---------|--------|-------------|
| `low` | 8192 | Light thinking |
| `max` | 32768 | Maximum thinking |

### Claude Example

```json
{
  "antigravity-claude-opus-4-6-thinking": {
    "name": "Claude Opus 4.6 Thinking (Antigravity)",
    "limit": { "context": 200000, "output": 64000 },
    "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
    "variants": {
      "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
      "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
    }
  }
}
```

You can define custom budgets:

```json
{
  "variants": {
    "minimal": { "thinkingConfig": { "thinkingBudget": 4096 } },
    "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
    "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
    "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
    "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
  }
}
```

---

## Legacy Budget Format (Deprecated)

For Gemini 3 models, the old `thinkingBudget` format is still supported but deprecated:

| Budget Range | Maps to Level |
|--------------|---------------|
| ≤ 8192 | low |
| ≤ 16384 | medium |
| > 16384 | high |

**Recommended:** Use `thinkingLevel` directly for Gemini 3 models.

---

## Tier-Suffixed Names

Tier-suffixed model names are still accepted:

- `antigravity-claude-opus-4-6-thinking-low`
- `antigravity-claude-opus-4-6-thinking-medium`
- `antigravity-claude-opus-4-6-thinking-high`
- `antigravity-gemini-3-pro-low`
- `antigravity-gemini-3-pro-high`
- `gemini-3-pro-low`
- `gemini-3-flash-medium`

However, **we recommend using simplified model names with variants** for:

- **Cleaner model picker** — 7 models instead of 12+
- **Simpler config** — No need to configure both `antigravity-` and `-preview` versions
- **Automatic quota routing** — Plugin handles model name transformation
- **Flexible budgets** — Define any budget, not just preset tiers
- **Future-proof** — Works with OpenCode's native variant system

---

## Benefits of Variants

| Before (tier-suffixed) | After (variants) |
|------------------------|------------------|
| 12+ separate models | 4 models with variants |
| Fixed thinking budgets | Customizable budgets |
| Cluttered model picker | Clean model picker |
| Hard to add new tiers | Easy to add new variants |
