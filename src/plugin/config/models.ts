import type { ProviderModel } from "../types";

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf" | "video" | "audio";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

export interface GeminiApiModel {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export interface AntigravityAvailableModel {
  displayName?: string;
  modelName?: string;
}

export type AntigravityAvailableModels = Record<string, AntigravityAvailableModel>;

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

/**
 * Gemini 3.8 Flash accepts Text/Image/Video/Audio/PDF input — wider than
 * DEFAULT_MODALITIES. The Antigravity catalog agrees: its Flash entries carry
 * `supportsVideo: true` and audio mime types in `supportedMimeTypes`.
 *
 * Built fresh per model entry so two entries never share one mutable array.
 */
const flashModalities = (): ModelModalities => ({
  input: ["text", "image", "pdf", "video", "audio"],
  output: ["text"],
});

const flashVariants = (): Record<string, ModelVariant> => ({
  low: { thinkingLevel: "low" },
  medium: { thinkingLevel: "medium" },
  high: { thinkingLevel: "high" },
});

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3.1-pro": {
    name: "Gemini 3.1 Pro (Antigravity)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    },
  },
  // Gemini 3.8 Flash serves low/medium/high only (no `minimal`) in the
  // Antigravity catalog (fetchAvailableModels, 2026-10-14).
  "antigravity-gemini-3.8-flash": {
    name: "Gemini 3.8 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: flashModalities(),
    variants: flashVariants(),
  },
  "antigravity-claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  },
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash (Gemini CLI)",
    limit: { context: 1048576, output: 65536 },
    modalities: flashModalities(),
    variants: flashVariants(),
  },
  "gemini-3.1-pro": {
    name: "Gemini 3.1 Pro (Gemini CLI)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
  "gemini-3.1-pro-preview-customtools": {
    name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
  },
};

function modelIdFromGeminiName(name: string | undefined): string | null {
  if (!name) return null;
  const id = name.replace(/^models\//, "").trim();
  return id || null;
}

function supportsGeminiGeneration(model: GeminiApiModel): boolean {
  const methods = model.supportedGenerationMethods ?? [];
  return methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function titleFromModelId(modelId: string): string {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultLimitForModel(modelId: string): ModelLimit {
  if (modelId.includes("claude")) {
    return { context: 200000, output: 64000 };
  }
  return { context: 1048576, output: 65536 };
}

function mergeWithStaticDefinition(
  modelId: string,
  discovered: OpencodeModelDefinition,
): OpencodeModelDefinition {
  const existing = OPENCODE_MODEL_DEFINITIONS[modelId];
  if (!existing) return discovered;

  return {
    ...existing,
    ...discovered,
    limit: discovered.limit ?? existing.limit,
    modalities: discovered.modalities ?? existing.modalities,
    variants: existing.variants,
  };
}

function antigravityModelIdFromEntry(sourceId: string, entry: AntigravityAvailableModel): string | null {
  const rawId = (entry.modelName || sourceId).trim();
  if (!rawId) return null;
  const modelId = rawId.replace(/^models\//, "");
  return modelId.startsWith("antigravity-") ? modelId : `antigravity-${modelId}`;
}

export function modelsFromGeminiApi(models: GeminiApiModel[]): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {};

  for (const model of models) {
    if (!supportsGeminiGeneration(model)) continue;
    const modelId = modelIdFromGeminiName(model.name) || model.baseModelId;
    if (!modelId) continue;

    const discovered: OpencodeModelDefinition = {
      name: model.displayName ? `${model.displayName} (Gemini API)` : `${titleFromModelId(modelId)} (Gemini API)`,
      limit: {
        context: model.inputTokenLimit ?? defaultLimitForModel(modelId).context,
        output: model.outputTokenLimit ?? defaultLimitForModel(modelId).output,
      },
      modalities: DEFAULT_MODALITIES,
    };
    definitions[modelId] = mergeWithStaticDefinition(modelId, discovered);
  }

  return definitions;
}

export function modelsFromAntigravityAvailableModels(
  models: AntigravityAvailableModels,
): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {};

  for (const [sourceId, entry] of Object.entries(models)) {
    const modelId = antigravityModelIdFromEntry(sourceId, entry);
    if (!modelId) continue;

    const discovered: OpencodeModelDefinition = {
      name: entry.displayName ? `${entry.displayName} (Antigravity)` : `${titleFromModelId(modelId)} (Antigravity)`,
      limit: defaultLimitForModel(modelId),
      modalities: DEFAULT_MODALITIES,
    };
    definitions[modelId] = mergeWithStaticDefinition(modelId, discovered);
  }

  return definitions;
}

export function mergeModelDefinitions(...definitions: Record<string, ProviderModel>[]): Record<string, ProviderModel> {
  return Object.assign({}, ...definitions);
}
