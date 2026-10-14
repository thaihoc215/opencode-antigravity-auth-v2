import { describe, expect, it } from "vitest";

import {
  OPENCODE_MODEL_DEFINITIONS,
  modelsFromAntigravityAvailableModels,
  modelsFromGeminiApi,
} from "./models";

const getModel = (name: string) => {
  const model = OPENCODE_MODEL_DEFINITIONS[name];
  if (!model) {
    throw new Error(`Missing model definition for ${name}`);
  }
  return model;
};

describe("OPENCODE_MODEL_DEFINITIONS", () => {
  it("includes the full set of configured models", () => {
    const modelNames = Object.keys(OPENCODE_MODEL_DEFINITIONS).sort();

    expect(modelNames).toEqual([
      "antigravity-claude-opus-4-6-thinking",
      "antigravity-claude-sonnet-4-6",
      "antigravity-gemini-3.1-pro",
      "antigravity-gemini-3.8-flash",
      "gemini-3.1-pro",
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.8-flash",
    ]);
  });

  it("defines Gemini 3 variants for Antigravity models", () => {
    expect(getModel("antigravity-gemini-3.1-pro").variants).toEqual({
      low: { thinkingLevel: "low" },
      high: { thinkingLevel: "high" },
    });
  });

  it("gives Gemini 3.8 Flash low/medium/high variants, its catalog limits and wide input", () => {
    // Antigravity catalog (fetchAvailableModels, 2026-10-14): gemini-3.8-flash-{low,medium,high},
    // maxTokens 1048576, maxOutputTokens 65536, supportsVideo with audio mime types.
    // The bare Gemini CLI id needs the variants too: without them OpenCode has
    // nothing to put in providerOptions.google, so selecting an effort would no-op.
    for (const id of ["antigravity-gemini-3.8-flash", "gemini-3.8-flash"]) {
      const model = getModel(id);
      expect(model.variants, `id=${id}`).toEqual({
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      });
      expect(model.limit, `id=${id}`).toEqual({ context: 1048576, output: 65536 });
      expect(model.modalities.input, `id=${id}`).toEqual(
        expect.arrayContaining(["text", "image", "pdf", "video", "audio"]),
      );
    }
  });

  it("defines thinking budget variants for Claude thinking models", () => {
    expect(getModel("antigravity-claude-opus-4-6-thinking").variants).toEqual({
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    });
  });
});

describe("dynamic model discovery helpers", () => {
  it("converts Gemini models.list metadata into OpenCode models", () => {
    const models = modelsFromGeminiApi([
      {
        name: "models/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        inputTokenLimit: 1000,
        outputTokenLimit: 2000,
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/text-embedding-004",
        displayName: "Text Embedding 004",
        supportedGenerationMethods: ["embedContent"],
      },
    ]);

    expect(models["gemini-2.5-flash"]).toMatchObject({
      name: "Gemini 2.5 Flash (Gemini API)",
      limit: { context: 1000, output: 2000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["text-embedding-004"]).toBeUndefined();
  });

  it("keeps Gemini models.list resource names distinct from shared base aliases", () => {
    const models = modelsFromGeminiApi([
      {
        name: "models/gemini-2.5-flash-001",
        baseModelId: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash 001",
        inputTokenLimit: 1000,
        outputTokenLimit: 2000,
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-2.5-flash-002",
        baseModelId: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash 002",
        inputTokenLimit: 3000,
        outputTokenLimit: 4000,
        supportedGenerationMethods: ["generateContent"],
      },
    ]);

    expect(models["gemini-2.5-flash-001"]?.limit).toEqual({ context: 1000, output: 2000 });
    expect(models["gemini-2.5-flash-002"]?.limit).toEqual({ context: 3000, output: 4000 });
  });

  it("converts Antigravity available models while preserving curated variants", () => {
    const models = modelsFromAntigravityAvailableModels({
      "gemini-3.8-flash": {
        displayName: "Gemini 3.8 Flash",
        modelName: "gemini-3.8-flash",
      },
      "claude-sonnet-4-6": {
        displayName: "Claude Sonnet 4.6",
      },
    });

    expect(models["antigravity-gemini-3.8-flash"]?.variants).toEqual({
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    });
    expect(models["antigravity-claude-sonnet-4-6"]).toMatchObject({
      name: "Claude Sonnet 4.6 (Antigravity)",
      limit: { context: 200000, output: 64000 },
    });
  });
});
