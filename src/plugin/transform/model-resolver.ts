/**
 * Model Resolution with Thinking Tier Support
 *
 * Resolves model names with tier suffixes (e.g., gemini-3-pro-high, claude-opus-4-6-thinking-low)
 * to their actual API model names and corresponding thinking configurations.
 */

import type { ResolvedModel, ThinkingTier, GoogleSearchConfig } from "./types";

export interface ModelResolverOptions {
  cli_first?: boolean;
}

/**
 * Thinking tier budgets by model family.
 * Claude and Gemini 2.5 Pro use numeric budgets.
 */
export const THINKING_TIER_BUDGETS = {
  claude: { low: 8192, medium: 16384, high: 32768 },
  default: { low: 4096, medium: 8192, high: 16384 },
} as const;

/**
 * Gemini 3 uses thinkingLevel strings instead of numeric budgets.
 * Flash supports: minimal, low, medium, high
 * Pro supports: low, high (no minimal/medium)
 */
export const GEMINI_3_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
] as const;

/**
 * Model aliases - maps user-friendly names to API model names.
 *
 * Format:
 * - Gemini 3 Pro variants: gemini-3-pro-{low,medium,high}
 * - Claude thinking variants: claude-{model}-thinking-{low,medium,high}
 * - Claude non-thinking: claude-{model} (no -thinking suffix)
 */
export const MODEL_ALIASES: Record<string, string> = {
  "gemini-flash-latest": "gemini-3.8-flash",

  // Gemini 3 variants - for Gemini CLI only (tier stripped, thinkingLevel used)
  // For Antigravity, these are bypassed and full model name is kept
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-3.1-pro-high": "gemini-3.1-pro",

  // Claude proxy names (gemini- prefix for compatibility)
  "gemini-claude-opus-4-6-thinking-low": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-medium": "claude-opus-4-6-thinking",
  "gemini-claude-opus-4-6-thinking-high": "claude-opus-4-6-thinking",
  "gemini-claude-sonnet-4-6": "claude-sonnet-4-6",

  // Image generation models - only gemini-3-pro-image is available via Antigravity API
  // Note: gemini-2.5-flash-image (Nano Banana) is NOT supported by Antigravity - only Google AI API
  // Reference: Antigravity-Manager/src-tauri/src/proxy/common/model_mapping.rs
};

const TIER_REGEX = /-(minimal|low|medium|high)$/;
const QUOTA_PREFIX_REGEX = /^antigravity-/i;
const GEMINI_3_PRO_REGEX = /^gemini-3(?:\.\d+)?-pro/i;
const GEMINI_3_FLASH_REGEX = /^gemini-3(?:\.\d+)?-flash/i;
/**
 * Flash generations that carry the effort level in the Antigravity backend id
 * itself (`gemini-3.8-flash-low` / `-medium` / `-high`).
 *
 * `defaultLevel` is what an id with no tier suffix resolves to. It is this
 * plugin's choice, not Google's: Google documents `medium` as the default, while
 * an untiered 3.8 selection resolves to `high` here (maximum thinking, at a
 * higher cost per request than the `low` default of the other Gemini entries).
 *
 * The Antigravity catalog serves no `-minimal` id for these generations, so a
 * requested `minimal` folds down to `low` — see `normalizeNoMinimalFlashTier`.
 */
const EFFORT_IN_ID_FLASH_GENERATIONS = [
  {
    // The catalog also lists `gemini-3.8-flash-tiered`, which is not exposed.
    regex: /^gemini-3\.8-flash(?:-(minimal|low|medium|high))?$/i,
    baseModel: "gemini-3.8-flash",
    defaultLevel: "high",
  },
] as const;

function matchEffortInIdFlash(model: string) {
  const modelWithoutQuota = model.replace(QUOTA_PREFIX_REGEX, "");
  for (const generation of EFFORT_IN_ID_FLASH_GENERATIONS) {
    const match = modelWithoutQuota.match(generation.regex);
    if (match) {
      return { generation, suffix: match[1] };
    }
  }
  return undefined;
}
/**
 * Dotted-minor Gemini generations (gemini-3.1, gemini-3.8, ...) use BARE model
 * names on the Gemini CLI backend, unlike the legacy 3.0 line (gemini-3-pro) which
 * uses a "-preview" suffix. Confirmed against the antigravity (`agy`) and `gemini`
 * CLIs, which ship `gemini-3.1-pro` (no `-preview`).
 */
const GEMINI_DOTTED_MINOR_REGEX = /^gemini-3\.(?:[1-9]\d*)/i;

// ANTIGRAVITY_ONLY_MODELS removed - all models now default to antigravity

/**
 * Image generation models - always route to Antigravity.
 * These models don't support thinking and require imageConfig.
 */
const IMAGE_GENERATION_MODELS = /image|imagen/i;

// Legacy LEGACY_ANTIGRAVITY_GEMINI3 regex removed - all Gemini models now default to antigravity

/**
 * Models that support thinking tier suffixes.
 * Only these models should have -low/-medium/-high stripped as thinking tiers.
 * GPT models like gpt-oss-120b-medium should NOT have -medium stripped.
 */
function supportsThinkingTiers(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("gemini-3") ||
    (lower.includes("claude") && lower.includes("thinking"))
  );
}

/**
 * Extracts thinking tier from model name suffix.
 * Only extracts tier for models that support thinking tiers.
 */
function extractThinkingTierFromModel(model: string): ThinkingTier | undefined {
  // Only extract tier for models that support thinking tiers
  if (!supportsThinkingTiers(model)) {
    return undefined;
  }
  const tierMatch = model.match(TIER_REGEX);
  return tierMatch?.[1] as ThinkingTier | undefined;
}

/**
 * Determines the budget family for a model.
 */
function getBudgetFamily(model: string): keyof typeof THINKING_TIER_BUDGETS {
  if (model.includes("claude")) {
    return "claude";
  }
  return "default";
}

/**
 * Checks if a model is a thinking-capable model.
 */
function isThinkingCapableModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("gemini-3")
  );
}

function isGemini3ProModel(model: string): boolean {
  return GEMINI_3_PRO_REGEX.test(model);
}

function isGemini3FlashModel(model: string): boolean {
  return GEMINI_3_FLASH_REGEX.test(model);
}

/**
 * Resolves the Antigravity backend id for the Flash generations that carry the
 * effort level in the id itself (see `EFFORT_IN_ID_FLASH_GENERATIONS`), or
 * `undefined` for anything else.
 *
 * Call this wherever a backend id must be (re-)derived after the effective
 * thinking level is known: the effort lives in the id, so skipping it silently
 * changes the effort. Already-resolved ids round-trip unchanged.
 */
export function resolveAntigravityGeminiFlashBackendModel(
  model: string,
  thinkingLevel?: string,
): string | undefined {
  const matched = matchEffortInIdFlash(model);
  if (!matched) {
    return undefined;
  }

  const { generation, suffix } = matched;
  const level = (
    thinkingLevel ??
    suffix ??
    generation.defaultLevel
  ).toLowerCase();
  const effort = level === "high" || level === "medium" ? level : "low";
  return `${generation.baseModel}-${effort}`;
}

/**
 * OpenCode's global output-token ceiling. It computes every request's budget as
 * `Math.min(model.limit.output, OUTPUT_TOKEN_MAX)` with `OUTPUT_TOKEN_MAX =
 * 32000`, so a model declaring 65536 still arrives here capped at 32000 and
 * raising the declared limit has no effect.
 *
 * Requests carrying exactly this value are therefore OpenCode's doing, not a
 * caller's deliberate choice — the distinction `restoreGeminiMaxOutputTokens`
 * relies on. `transform/claude.ts` already works around the same ceiling for
 * Claude thinking models.
 */
export const OPENCODE_OUTPUT_TOKEN_CAP = 32000;

/**
 * Real per-model output-token limits, as reported by the Antigravity catalog
 * (`v1internal:fetchAvailableModels` → `maxOutputTokens`), read 2026-08-17.
 * They are NOT uniform: the Gemini 3 Flash line reports 65536 while the Pro
 * line, 3.1 Flash Lite and the whole 2.5 family report 65535 — so this is a
 * table of observed values, not a single constant.
 *
 * Order matters: the first matching entry wins, so narrower ids come first.
 */
const GEMINI_OUTPUT_TOKEN_LIMITS: ReadonlyArray<{
  regex: RegExp;
  maxOutputTokens: number;
}> = [
  { regex: /^gemini-3\.1-flash-lite/i, maxOutputTokens: 65535 },
  { regex: /^gemini-3(?:\.\d+)?-flash/i, maxOutputTokens: 65536 },
  { regex: /^gemini-3(?:\.\d+)?-pro/i, maxOutputTokens: 65535 },
  { regex: /^gemini-pro-agent$/i, maxOutputTokens: 65535 },
  { regex: /^gemini-2\.5-/i, maxOutputTokens: 65535 },
];

/**
 * The output-token limit the backend advertises for a Gemini model, or
 * `undefined` for non-Gemini and image models (the catalog reports no limit for
 * image ids, and they do not take an output budget).
 */
export function geminiMaxOutputTokens(model: string): number | undefined {
  const bare = model.replace(QUOTA_PREFIX_REGEX, "");
  if (IMAGE_GENERATION_MODELS.test(bare)) {
    return undefined;
  }
  return GEMINI_OUTPUT_TOKEN_LIMITS.find((entry) => entry.regex.test(bare))
    ?.maxOutputTokens;
}

/**
 * Restores a Gemini request's output budget to what the model actually allows.
 *
 * OpenCode caps every request at `Math.min(model.limit.output, 32000)`, so
 * Gemini models that permit 65536/65535 are asked for barely half of it and
 * long responses truncate early. Declaring a higher `limit.output` cannot fix
 * this — the cap is a `Math.min` on OpenCode's side.
 *
 * Only a budget equal to the cap is rewritten. Note the one false positive that
 * implies: a caller who deliberately asks for exactly 32000 is indistinguishable
 * from OpenCode's ceiling and gets raised too. Any other value is left alone.
 *
 * Accepts either spelling of the key — `max_output_tokens` reaches
 * `generationConfig` too — and collapses to the camelCase one so the payload
 * never carries two conflicting budgets.
 *
 * Lives here rather than in `request.ts` because both request pipelines need it:
 * the Antigravity path and the api-key/`agy-sdk` public-API fallback.
 */
export function restoreGeminiMaxOutputTokens(
  requestPayload: Record<string, unknown>,
  effectiveModel: string,
): void {
  const limit = geminiMaxOutputTokens(effectiveModel);
  if (limit === undefined) {
    return;
  }

  const generationConfig = requestPayload.generationConfig;
  if (!generationConfig || typeof generationConfig !== "object") {
    return;
  }

  const config = generationConfig as Record<string, unknown>;
  const current = config.maxOutputTokens ?? config.max_output_tokens;
  if (current === OPENCODE_OUTPUT_TOKEN_CAP) {
    config.maxOutputTokens = limit;
    delete config.max_output_tokens;
  }
}

/**
 * The thinkingLevel a Gemini 3 model runs at when the request names no tier.
 * `low` for everything except the effort-in-id Flash generations, which carry
 * their own `defaultLevel` (3.8 Flash: `high`).
 */
function defaultGemini3ThinkingLevel(model: string): string {
  const matched = matchEffortInIdFlash(model);
  if (!matched) {
    return "low";
  }
  return (matched.suffix ?? matched.generation.defaultLevel).toLowerCase();
}

/**
 * Gemini 3.8 Flash serves only low/medium/high. A `minimal` request against the
 * effort-in-id generations is folded to `low` so that neither the backend id nor the `thinkingLevel` parameter carries
 * a level the backend rejects.
 */
function normalizeNoMinimalFlashTier(
  model: string,
  tier: ThinkingTier | undefined,
): ThinkingTier | undefined {
  // Keyed off the requested suffix rather than `tier`: TIER_REGEX matches
  // `minimal`, but ThinkingTier only names low/medium/high, so a "minimal"
  // tier reaches here as an unrepresentable value.
  const bare = model.replace(QUOTA_PREFIX_REGEX, "");
  if (!/-minimal$/i.test(bare)) {
    return tier;
  }
  return matchEffortInIdFlash(bare) ? "low" : tier;
}

/**
 * Resolves a model name with optional tier suffix and quota prefix to its actual API model name
 * and corresponding thinking configuration.
 *
 * Quota routing:
 * - Default to Antigravity quota unless cli_first is enabled for Gemini models
 * - Fallback to Gemini CLI happens at account rotation level when Antigravity is exhausted
 * - "antigravity-" prefix marks explicit quota (no fallback allowed)
 * - Claude and image models always use Antigravity
 *
 * Examples:
 * - "gemini-2.5-flash" → { quotaPreference: "antigravity" }
 * - "gemini-3-pro-preview" → { quotaPreference: "antigravity" }
 * - "antigravity-gemini-3-pro-high" → { quotaPreference: "antigravity", explicitQuota: true }
 * - "claude-opus-4-6-thinking-medium" → { quotaPreference: "antigravity" }
 *
 * @param requestedModel - The model name from the request
 * @param options - Optional configuration including cli_first preference
 * @returns Resolved model with thinking configuration
 */
export function resolveModelWithTier(
  requestedModel: string,
  options: ModelResolverOptions = {},
): ResolvedModel {
  const isAntigravity = QUOTA_PREFIX_REGEX.test(requestedModel);
  const modelWithoutQuota = requestedModel.replace(QUOTA_PREFIX_REGEX, "");

  const requestedTier = extractThinkingTierFromModel(modelWithoutQuota);
  const tier = normalizeNoMinimalFlashTier(modelWithoutQuota, requestedTier);
  const baseName = requestedTier
    ? modelWithoutQuota.replace(TIER_REGEX, "")
    : modelWithoutQuota;

  const isImageModel = IMAGE_GENERATION_MODELS.test(modelWithoutQuota);
  const isClaudeModel = modelWithoutQuota.toLowerCase().includes("claude");

  // All models default to Antigravity quota unless cli_first is enabled
  // Fallback to gemini-cli happens at the account rotation level when Antigravity is exhausted
  const preferGeminiCli =
    options.cli_first === true &&
    !isAntigravity &&
    !isImageModel &&
    !isClaudeModel;
  const quotaPreference = preferGeminiCli
    ? ("gemini-cli" as const)
    : ("antigravity" as const);
  const explicitQuota = isAntigravity || isImageModel;

  const isGemini3 = modelWithoutQuota.toLowerCase().startsWith("gemini-3");
  const skipAlias = isAntigravity && isGemini3;

  // For Antigravity Gemini 3 Pro models without explicit tier, append default tier.
  // Antigravity API: gemini-3-pro requires tier suffix (gemini-3-pro-low/high)
  //                  gemini-3.8-flash carries the effort in the id (gemini-3.8-flash-high)
  //                  other gemini-3-flash models use bare name + thinkingLevel param
  // Pro defaults to -low unless an explicit tier is provided
  const isGemini3Pro = isGemini3ProModel(modelWithoutQuota);
  const isGemini3Flash = isGemini3FlashModel(modelWithoutQuota);

  let antigravityModel = modelWithoutQuota;
  if (skipAlias) {
    const flashBackendModel = resolveAntigravityGeminiFlashBackendModel(
      modelWithoutQuota,
      tier,
    );
    if (flashBackendModel) {
      antigravityModel = flashBackendModel;
    } else if (isGemini3Pro && !tier && !isImageModel) {
      antigravityModel = `${modelWithoutQuota}-low`;
    } else if (isGemini3Flash && tier) {
      antigravityModel = baseName;
    }
  }

  const actualModel = skipAlias
    ? antigravityModel
    : MODEL_ALIASES[modelWithoutQuota] || MODEL_ALIASES[baseName] || baseName;

  const resolvedModel = actualModel;

  const isThinking = isThinkingCapableModel(resolvedModel);

  // Image generation models don't support thinking - return early without thinking config
  if (isImageModel) {
    return {
      actualModel: resolvedModel,
      isThinkingModel: false,
      isImageModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  // Check if this is a Gemini 3 model (works for both aliased and skipAlias paths)
  const isEffectiveGemini3 = resolvedModel.toLowerCase().includes("gemini-3");
  const isClaudeThinking =
    resolvedModel.toLowerCase().includes("claude") &&
    resolvedModel.toLowerCase().includes("thinking");

  if (!tier) {
    // Gemini 3 models without explicit tier get a default thinkingLevel
    if (isEffectiveGemini3) {
      return {
        actualModel: resolvedModel,
        thinkingLevel: defaultGemini3ThinkingLevel(resolvedModel),
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    // Claude thinking models without explicit tier get max budget (32768)
    // Per Anthropic docs, budget_tokens is required when enabling extended thinking
    if (isClaudeThinking) {
      return {
        actualModel: resolvedModel,
        thinkingBudget: THINKING_TIER_BUDGETS.claude.high,
        isThinkingModel: true,
        quotaPreference,
        explicitQuota,
      };
    }
    return {
      actualModel: resolvedModel,
      isThinkingModel: isThinking,
      quotaPreference,
      explicitQuota,
    };
  }

  // Gemini 3 models with tier always get thinkingLevel set
  if (isEffectiveGemini3) {
    return {
      actualModel: resolvedModel,
      thinkingLevel: tier,
      tier,
      isThinkingModel: true,
      quotaPreference,
      explicitQuota,
    };
  }

  const budgetFamily = getBudgetFamily(resolvedModel);
  const budgets = THINKING_TIER_BUDGETS[budgetFamily];
  const thinkingBudget = budgets[tier];

  return {
    actualModel: resolvedModel,
    thinkingBudget,
    tier,
    isThinkingModel: isThinking,
    quotaPreference,
    explicitQuota,
  };
}

/**
 * Gets the model family for routing decisions.
 */
export function getModelFamily(
  model: string,
): "claude" | "gemini-flash" | "gemini-pro" {
  const lower = model.toLowerCase();
  if (lower.includes("claude")) {
    return "claude";
  }
  if (lower.includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

/**
 * Variant config from OpenCode's providerOptions.
 */
export interface VariantConfig {
  thinkingBudget?: number;
  googleSearch?: GoogleSearchConfig;
}

/**
 * Maps a thinking budget to Gemini 3 thinking level.
 * ≤8192 → low, ≤16384 → medium, >16384 → high
 */
function budgetToGemini3Level(budget: number): "low" | "medium" | "high" {
  if (budget <= 8192) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}

/**
 * Resolves model name for a specific headerStyle (quota fallback support).
 * Transforms model names when switching between gemini-cli and antigravity quotas.
 *
 * Issue #103: When quota fallback occurs, model names need to be transformed:
 * - gemini-3-flash-preview (gemini-cli) → gemini-3-flash (antigravity)
 * - gemini-3-pro-preview (gemini-cli) → gemini-3-pro-low (antigravity)
 * - gemini-3-flash (antigravity) → gemini-3-flash-preview (gemini-cli)
 */
/**
 * Maps Antigravity-only bare Gemini ids to the public Gemini API equivalent
 * served by `generativelanguage.googleapis.com/v1beta`. Verified live against
 * GET /v1beta/models (May 2026).
 *
 * Used by `resolveModelForHeaderStyle(..., "agy-sdk")` so that when OAuth
 * Antigravity quota is exhausted and the api-key fallback kicks in, requests
 * for `antigravity-gemini-3.1-pro` (etc.) are rewritten to the public-API
 * variant Google actually serves — instead of producing a deterministic 404
 * on the bare id.
 *
 * Returns `undefined` when the model is Antigravity-only but has no known
 * public-API equivalent (e.g. Claude models). Callers should treat that as
 * "not servable via api-key path" and route accordingly.
 */
const ANTIGRAVITY_TO_PUBLIC_API_MODEL_MAP: ReadonlyMap<string, string> =
  new Map([
    ["gemini-3.1-pro", "gemini-3.1-pro-preview"],
  ]);

export function mapAntigravityModelToPublicApi(
  model: string,
): string | undefined {
  const stripped = model.toLowerCase().replace(/^antigravity-/, "");
  // Strip tier suffixes (-minimal/-low/-medium/-high) so
  // `antigravity-gemini-3.1-pro-high` maps the same as `antigravity-gemini-3.1-pro`.
  const base = stripped.replace(/-(minimal|low|medium|high)$/, "");
  return ANTIGRAVITY_TO_PUBLIC_API_MODEL_MAP.get(base);
}

export function resolveModelForHeaderStyle(
  requestedModel: string,
  headerStyle: "antigravity" | "gemini-cli" | "agy-sdk",
): ResolvedModel {
  const aliasResolvedModel = MODEL_ALIASES[requestedModel];
  if (aliasResolvedModel) {
    return resolveModelForHeaderStyle(aliasResolvedModel, headerStyle);
  }

  const lower = requestedModel.toLowerCase();
  const isGemini3 = lower.includes("gemini-3");

  if (headerStyle === "agy-sdk") {
    const modelWithTier = requestedModel.replace(/^antigravity-/i, "");
    const stripped = modelWithTier.replace(/-(minimal|low|medium|high)$/i, "");
    // Translate Antigravity-only ids (e.g. `gemini-3.1-pro`) to the public Gemini
    // API equivalent (`gemini-3.1-pro-preview`). Falls back to the bare stripped
    // name when no translation exists (covers `gemini-3.8-flash`, etc.).
    const transformedModel =
      mapAntigravityModelToPublicApi(stripped) ?? stripped;
    return {
      ...resolveModelWithTier(modelWithTier),
      actualModel: transformedModel,
      quotaPreference: "agy-sdk",
      explicitQuota: false,
    };
  }

  if (!isGemini3) {
    return resolveModelWithTier(requestedModel);
  }

  if (headerStyle === "antigravity") {
    let transformedModel = requestedModel
      .replace(/-preview-customtools$/i, "")
      .replace(/-preview$/i, "")
      .replace(/^antigravity-/i, "");

    const isGemini3Pro = isGemini3ProModel(transformedModel);
    const hasTierSuffix = /-(low|medium|high)$/i.test(transformedModel);
    const isImageModel = IMAGE_GENERATION_MODELS.test(transformedModel);

    // Don't add tier suffix to image models - they don't support thinking
    if (isGemini3Pro && !hasTierSuffix && !isImageModel) {
      transformedModel = `${transformedModel}-low`;
    }

    const prefixedModel = `antigravity-${transformedModel}`;
    return resolveModelWithTier(prefixedModel);
  }

  if (headerStyle === "gemini-cli") {
    let transformedModel = requestedModel
      .replace(/^antigravity-/i, "")
      .replace(/-(minimal|low|medium|high)$/i, "");

    // Only the legacy 3.0 line takes a "-preview" suffix on the Gemini CLI backend.
    // Dotted-minor generations (gemini-3.1+, gemini-3.8, ...) use bare names there.
    const hasPreviewSuffix = /-preview($|-)/i.test(transformedModel);
    const usesBareName = GEMINI_DOTTED_MINOR_REGEX.test(transformedModel);
    if (usesBareName && /-preview$/i.test(transformedModel)) {
      transformedModel = transformedModel.replace(/-preview$/i, "");
    } else if (!hasPreviewSuffix && !usesBareName) {
      transformedModel = `${transformedModel}-preview`;
    }

    return {
      ...resolveModelWithTier(transformedModel),
      quotaPreference: "gemini-cli",
    };
  }

  return resolveModelWithTier(requestedModel);
}

/**
 * Resolves model with variant config from providerOptions.
 * Variant config takes priority over tier suffix in model name.
 */
export function resolveModelWithVariant(
  requestedModel: string,
  variantConfig?: VariantConfig,
): ResolvedModel {
  const base = resolveModelWithTier(requestedModel);

  if (!variantConfig) {
    return base;
  }

  // Apply Google Search config if present
  if (variantConfig.googleSearch) {
    base.googleSearch = variantConfig.googleSearch;
    base.configSource = "variant";
  }

  if (!variantConfig.thinkingBudget) {
    return base;
  }

  const budget = variantConfig.thinkingBudget;
  const isGemini3 = base.actualModel.toLowerCase().includes("gemini-3");

  if (isGemini3) {
    const level = budgetToGemini3Level(budget);
    const isAntigravity = base.quotaPreference === "antigravity";
    const isAntigravityGemini3Pro =
      isAntigravity && isGemini3ProModel(base.actualModel);

    let actualModel = base.actualModel;
    if (isAntigravityGemini3Pro) {
      const baseModel = base.actualModel.replace(/-(low|medium|high)$/, "");
      actualModel = `${baseModel}-${level}`;
    } else if (isAntigravity) {
      // Flash generations that encode effort in the backend id must move the id
      // with the variant.
      actualModel =
        resolveAntigravityGeminiFlashBackendModel(base.actualModel, level) ??
        actualModel;
    }

    return {
      ...base,
      actualModel,
      thinkingLevel: level,
      thinkingBudget: undefined,
      configSource: "variant",
    };
  }

  return {
    ...base,
    thinkingBudget: budget,
    configSource: "variant",
  };
}
