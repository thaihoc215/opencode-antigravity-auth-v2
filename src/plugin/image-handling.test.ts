import { describe, it, expect } from "vitest";

import { transformThinkingParts } from "./request-helpers";
import { deduplicateThinkingText, createThoughtBuffer } from "./core/streaming/transformer";

function imageResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { mimeType: "image/png", data: "AAAABBBB" } },
          ],
        },
      },
    ],
  };
}

// No model this plugin serves generates images. Inline data a response does
// carry is passed to OpenCode unchanged (the AI SDK turns it into a file part).
describe("image inlineData handling", () => {
  it("passes inlineData through the response transform unchanged", () => {
    const result = transformThinkingParts(imageResponse()) as ReturnType<typeof imageResponse>;
    expect(result.candidates[0]!.content.parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: "AAAABBBB" },
    });
  });

  it("passes inlineData through streaming deduplication unchanged", () => {
    const result = deduplicateThinkingText(imageResponse(), createThoughtBuffer()) as ReturnType<typeof imageResponse>;
    expect(result.candidates[0]!.content.parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: "AAAABBBB" },
    });
  });
});
