import { describe, expect, it } from "vitest";
import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { applyV2Model, toV2Model, toVariantSettings } from "./models";

describe("toVariantSettings", () => {
  it("wraps a thinkingLevel variant into the Google thinkingConfig", () => {
    expect(toVariantSettings({ thinkingLevel: "high" })).toEqual({
      thinkingConfig: { thinkingLevel: "high" },
    });
  });

  it("keeps a budget-based variant under thinkingConfig", () => {
    expect(toVariantSettings({ thinkingConfig: { thinkingBudget: 8192 } })).toEqual({
      thinkingConfig: { thinkingBudget: 8192 },
    });
  });

  it("returns undefined for an empty variant", () => {
    expect(toVariantSettings({})).toBeUndefined();
    expect(toVariantSettings(undefined)).toBeUndefined();
  });
});

describe("toV2Model", () => {
  it("converts the Gemini 3.8 Flash definition", () => {
    const patch = toV2Model(
      "antigravity-gemini-3.8-flash",
      OPENCODE_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash"]!,
    );
    expect(patch).toEqual({
      name: "Gemini 3.8 Flash (Antigravity)",
      limit: { context: 1048576, output: 65536 },
      capabilities: {
        tools: true,
        input: ["text", "image", "pdf", "video", "audio"],
        output: ["text"],
      },
      variants: [
        { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } } },
        { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } } },
        { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } },
      ],
    });
  });

  it("falls back to the id and text-only modalities", () => {
    const patch = toV2Model("bare", {});
    expect(patch.name).toBe("bare");
    expect(patch.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
    expect(patch.variants).toEqual([]);
  });
});

describe("applyV2Model", () => {
  it("overwrites the draft, zeroes cost, and drops a per-model package", () => {
    const draft = {
      name: "old",
      limit: { context: 1, output: 1 },
      capabilities: { tools: false, input: [], output: [] },
      variants: [],
      cost: [{ input: 1 }],
      status: "deprecated",
      enabled: false,
      package: "@ai-sdk/google",
    } as unknown as Parameters<typeof applyV2Model>[0];

    applyV2Model(draft, toV2Model("gemini-3.8-flash", OPENCODE_MODEL_DEFINITIONS["gemini-3.8-flash"]!));

    expect(draft.name).toBe("Gemini 3.8 Flash (Gemini CLI)");
    expect(draft.cost).toEqual([]);
    expect(draft.status).toBe("active");
    expect(draft.enabled).toBe(true);
    expect("package" in draft).toBe(false);
    expect(draft.variants.map((variant) => variant.id)).toEqual(["low", "medium", "high"]);
  });
});
