import type { Model } from "@opencode/plugin";
import type { DeepMutable } from "@opencode/plugin/promise/types";
import type { ProviderModel } from "../plugin/types";

/** The subset of a V2 `Model.Info` this plugin writes. */
export interface V2ModelPatch {
  name: string;
  limit: { context: number; input?: number; output: number };
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: Array<{ id: string; settings?: Record<string, unknown> }>;
}

const MODALITIES = ["text", "image", "pdf", "video", "audio"] as const;

function modalityList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  // The core's normalized models carry V1 capability flags: { text: true, image: false, ... }
  if (value && typeof value === "object") {
    const flags = value as Record<string, unknown>;
    return MODALITIES.filter((modality) => flags[modality] === true);
  }
  return undefined;
}

/**
 * Converts a V1 variant (`{ thinkingLevel }` or `{ thinkingConfig: { thinkingBudget } }`)
 * into V2 variant settings. V2 hands model settings to the AI SDK as Google
 * provider options, where thinking settings live under `thinkingConfig`.
 */
export function toVariantSettings(variant: unknown): Record<string, unknown> | undefined {
  if (!variant || typeof variant !== "object") return undefined;
  const { thinkingLevel, thinkingConfig, ...rest } = variant as Record<string, unknown>;
  const settings: Record<string, unknown> = { ...rest };
  if (typeof thinkingLevel === "string") {
    settings.thinkingConfig = { thinkingLevel };
  } else if (thinkingConfig && typeof thinkingConfig === "object") {
    settings.thinkingConfig = { ...(thinkingConfig as Record<string, unknown>) };
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Converts a V1 model definition into the fields of a V2 `Model.Info`. */
export function toV2Model(id: string, definition: ProviderModel): V2ModelPatch {
  const limit = (definition.limit ?? {}) as { context?: number; input?: number; output?: number };
  const modalities = definition.modalities as { input?: unknown; output?: unknown } | undefined;
  const capabilities = definition.capabilities as { input?: unknown; output?: unknown; toolcall?: unknown } | undefined;
  const variants = (definition.variants ?? {}) as Record<string, unknown>;

  return {
    name: typeof definition.name === "string" ? definition.name : id,
    limit: {
      context: limit.context ?? 0,
      ...(limit.input !== undefined ? { input: limit.input } : {}),
      output: limit.output ?? 0,
    },
    capabilities: {
      tools: capabilities?.toolcall !== false,
      input: modalityList(modalities?.input) ?? modalityList(capabilities?.input) ?? ["text"],
      output: modalityList(modalities?.output) ?? modalityList(capabilities?.output) ?? ["text"],
    },
    variants: Object.entries(variants).map(([variantId, variant]) => {
      const settings = toVariantSettings(variant);
      return settings ? { id: variantId, settings } : { id: variantId };
    }),
  };
}

/**
 * Writes a converted model onto a mutable V2 model draft. The draft starts as
 * either an existing source model or a default for a new model id.
 */
export function applyV2Model(draft: DeepMutable<Model.Info>, patch: V2ModelPatch): void {
  draft.name = patch.name;
  draft.limit = { ...patch.limit };
  draft.capabilities = {
    tools: patch.capabilities.tools,
    input: [...patch.capabilities.input],
    output: [...patch.capabilities.output],
  };
  // Variant ids are branded strings in the schema; DeepMutable cannot express
  // a branded string, so the plain-string ids need a cast.
  draft.variants = patch.variants.map((variant) => ({ ...variant })) as unknown as typeof draft.variants;
  // Requests are served by the Antigravity quota, not billed per token.
  draft.cost = [];
  draft.status = "active";
  draft.enabled = true;
  // Route through the provider's package (this plugin's AI SDK), never a per-model override.
  delete draft.package;
}
