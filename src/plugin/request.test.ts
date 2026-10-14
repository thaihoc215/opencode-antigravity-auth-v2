import { describe, it, expect } from "vitest";
import {
  prepareAntigravityRequest,
  transformAntigravityResponse,
  isGenerativeLanguageRequest,
  __testExports,
} from "./request";
import { DEFAULT_CONFIG } from "./config";
import { initializeDebug } from "./debug";
import { SKIP_THOUGHT_SIGNATURE } from "../constants";
import { cacheSignature, getCachedSignature, clearSignatureCache } from "./cache";
import type { SignatureStore, ThoughtBuffer, StreamingCallbacks, StreamingOptions } from "./core/streaming/types";

const {
  buildSignatureSessionKey,
  hashConversationSeed,
  extractTextFromContent,
  extractConversationSeedFromMessages,
  extractConversationSeedFromContents,
  resolveProjectKey,
  sanitizeRequestPayloadForAntigravity,
  signatureCacheProjectKey,
  generateSyntheticProjectId,
  getDisplayedThinkingHashes,
  MIN_SIGNATURE_LENGTH,
  transformStreamingPayload,
  createStreamingTransformer,
  transformSseLine,
} = __testExports;

function createMockSignatureStore(): SignatureStore {
  const store = new Map<string, { text: string; signature: string }>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: { text: string; signature: string }) => store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
  };
}

function createMockThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (idx: number) => buffer.get(idx),
    set: (idx: number, text: string) => buffer.set(idx, text),
    clear: () => buffer.clear(),
  };
}

const defaultCallbacks: StreamingCallbacks = {};
const defaultOptions: StreamingOptions = {};
const defaultDebugState = { injected: false };

describe("request.ts", () => {
  describe("isGenerativeLanguageRequest", () => {
    it("returns true for generativelanguage.googleapis.com URLs", () => {
      expect(isGenerativeLanguageRequest("https://generativelanguage.googleapis.com/v1/models")).toBe(true);
      expect(isGenerativeLanguageRequest(new Request("https://generativelanguage.googleapis.com/v1/models"))).toBe(true);
    });

    it("returns false for other URLs", () => {
      expect(isGenerativeLanguageRequest("https://api.anthropic.com/v1/messages")).toBe(false);
      expect(isGenerativeLanguageRequest("https://example.com/redirect?next=https://generativelanguage.googleapis.com/v1/models")).toBe(false);
    });

    it("returns false for non-string inputs", () => {
      expect(isGenerativeLanguageRequest({} as any)).toBe(false);
      expect(isGenerativeLanguageRequest(new Request("https://example.com"))).toBe(false);
    });
  });

  describe("buildSignatureSessionKey", () => {
    it("builds key from sessionId, model, project, and conversation", () => {
      const key = buildSignatureSessionKey("session-1", "claude-3", "conv-456", "proj-123");
      expect(key).toBe("session-1:claude-3:proj-123:conv-456");
    });

    it("uses defaults for missing optional params", () => {
      expect(buildSignatureSessionKey("s1", undefined, undefined, undefined)).toBe("s1:unknown:default:default");
      expect(buildSignatureSessionKey("s1", "model", undefined, undefined)).toBe("s1:model:default:default");
    });

    it("handles empty strings as defaults", () => {
      expect(buildSignatureSessionKey("s1", "", "", "")).toBe("s1:unknown:default:default");
    });
  });

  describe("hashConversationSeed", () => {
    it("returns consistent hash for same input", () => {
      const hash1 = hashConversationSeed("test-seed");
      const hash2 = hashConversationSeed("test-seed");
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different inputs", () => {
      const hash1 = hashConversationSeed("seed-1");
      const hash2 = hashConversationSeed("seed-2");
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty string", () => {
      const hash = hashConversationSeed("");
      expect(hash).toBeTruthy();
    });
  });

  describe("extractTextFromContent", () => {
    it("extracts text from string content", () => {
      expect(extractTextFromContent("hello world")).toBe("hello world");
    });

    it("extracts first text from content array with text blocks", () => {
      const content = [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ];
      expect(extractTextFromContent(content)).toBe("hello");
    });

    it("returns empty string for non-text blocks", () => {
      const content = [{ type: "image", source: {} }];
      expect(extractTextFromContent(content)).toBe("");
    });

    it("returns first text block only (not concatenated)", () => {
      const content = [
        { type: "text", text: "before" },
        { type: "image", source: {} },
        { type: "text", text: "after" },
      ];
      expect(extractTextFromContent(content)).toBe("before");
    });

    it("returns empty string for null/undefined", () => {
      expect(extractTextFromContent(null)).toBe("");
      expect(extractTextFromContent(undefined)).toBe("");
    });
  });

  describe("extractConversationSeedFromMessages", () => {
    it("extracts seed from first user message", () => {
      const messages = [
        { role: "user", content: "first message" },
        { role: "assistant", content: "response" },
      ];
      const seed = extractConversationSeedFromMessages(messages);
      expect(seed).toContain("first message");
    });

    it("returns empty string when no user messages", () => {
      const messages = [{ role: "assistant", content: "response" }];
      expect(extractConversationSeedFromMessages(messages)).toBe("");
    });

    it("handles empty messages array", () => {
      expect(extractConversationSeedFromMessages([])).toBe("");
    });
  });

  describe("extractConversationSeedFromContents", () => {
    it("extracts seed from first user content", () => {
      const contents = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi" }] },
      ];
      const seed = extractConversationSeedFromContents(contents);
      expect(seed).toContain("hello");
    });

    it("returns empty string when no user content", () => {
      const contents = [{ role: "model", parts: [{ text: "hi" }] }];
      expect(extractConversationSeedFromContents(contents)).toBe("");
    });
  });

  describe("resolveProjectKey", () => {
    it("returns candidate if it is a string", () => {
      expect(resolveProjectKey("my-project")).toBe("my-project");
    });

    it("returns fallback if candidate is not a string", () => {
      expect(resolveProjectKey(null, "fallback")).toBe("fallback");
      expect(resolveProjectKey(undefined, "fallback")).toBe("fallback");
      expect(resolveProjectKey({}, "fallback")).toBe("fallback");
    });

    it("returns undefined if no valid candidate or fallback", () => {
      expect(resolveProjectKey(null)).toBeUndefined();
      expect(resolveProjectKey(undefined)).toBeUndefined();
    });
  });

  describe("generateSyntheticProjectId", () => {
    it("generates a string in expected format", () => {
      const id = generateSyntheticProjectId();
      expect(id).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{5}$/);
    });

    it("generates unique IDs on each call", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(generateSyntheticProjectId());
      }
      expect(ids.size).toBe(10);
    });
  });

  describe("MIN_SIGNATURE_LENGTH", () => {
    it("is 50", () => {
      expect(MIN_SIGNATURE_LENGTH).toBe(50);
    });
  });

  describe("transformSseLine", () => {
    const callTransformSseLine = (line: string) => {
      const store = createMockSignatureStore();
      const buffer = createMockThoughtBuffer();
      const sentBuffer = createMockThoughtBuffer();
      return transformSseLine(line, store, buffer, sentBuffer, defaultCallbacks, defaultOptions, { ...defaultDebugState });
    };

    it("returns empty lines unchanged", () => {
      expect(callTransformSseLine("")).toBe("");
      expect(callTransformSseLine("   ")).toBe("   ");
    });

    it("returns non-data lines unchanged", () => {
      expect(callTransformSseLine("event: message")).toBe("event: message");
      expect(callTransformSseLine(": heartbeat")).toBe(": heartbeat");
    });

    it("handles data: [DONE] unchanged", () => {
      expect(callTransformSseLine("data: [DONE]")).toBe("data: [DONE]");
    });

    it("handles invalid JSON gracefully", () => {
      expect(callTransformSseLine("data: not-json")).toBe("data: not-json");
      expect(callTransformSseLine("data: {invalid}")).toBe("data: {invalid}");
    });

    it("passes through valid JSON without thinking parts", () => {
      const payload = { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
      expect(result).toContain("hello");
    });

    it("transforms thinking parts in streaming data", () => {
      const payload = {
        candidates: [{
          content: {
            parts: [{ thought: true, text: "reasoning..." }]
          }
        }]
      };
      const line = `data: ${JSON.stringify(payload)}`;
      const result = callTransformSseLine(line);
      expect(result).toContain("data:");
    });
  });

  describe("transformStreamingPayload", () => {
    it("handles empty string", () => {
      expect(transformStreamingPayload("")).toBe("");
    });

    it("handles single line without data prefix", () => {
      expect(transformStreamingPayload("event: ping")).toBe("event: ping");
    });

    it("handles multiple lines", () => {
      const input = "event: message\ndata: [DONE]\n";
      const result = transformStreamingPayload(input);
      expect(result).toContain("event: message");
      expect(result).toContain("data: [DONE]");
    });

    it("preserves line structure", () => {
      const input = "line1\nline2\nline3";
      const result = transformStreamingPayload(input);
      const lines = result.split("\n");
      expect(lines.length).toBe(3);
    });
  });

  describe("createStreamingTransformer", () => {
    /** Streams `chunks` through a transformer and returns the output text. */
    async function runTransformer(chunks: string[]): Promise<string> {
      const transformer = createStreamingTransformer(createMockSignatureStore(), defaultCallbacks);
      const encoder = new TextEncoder();
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(source.pipeThrough(transformer)).text();
    }

    it("reassembles an SSE line split across many chunks", async () => {
      const payload = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "x".repeat(5000) }] } }] } });
      const line = `data: ${payload}\n\n`;
      const chunks = line.match(/[\s\S]{1,97}/g)!;

      const output = await runTransformer(chunks);

      const data = output.split("\n").find((entry) => entry.startsWith("data: {\"candidates"));
      expect(JSON.parse(data!.slice(6)).candidates[0].content.parts[0].text).toHaveLength(5000);
    });

    it("handles a very long line in small chunks in linear time", async () => {
      const text = "y".repeat(8 * 1024 * 1024);
      const line = `data: {"response":{"candidates":[{"content":{"parts":[{"text":"${text}"}]}}]}}\n`;
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += 16 * 1024) chunks.push(line.slice(i, i + 16 * 1024));

      const started = performance.now();
      const output = await runTransformer(chunks);

      expect(output.length).toBeGreaterThan(text.length);
      expect(performance.now() - started).toBeLessThan(1500);
    });

    it("returns a TransformStream", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      expect(transformer).toBeInstanceOf(TransformStream);
      expect(transformer.readable).toBeDefined();
      expect(transformer.writable).toBeDefined();
    });

    it("accepts optional signatureSessionKey", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts optional debugText", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", debugText: "debug info" });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("accepts cacheSignatures flag", () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks, { signatureSessionKey: "session-key", cacheSignatures: true });
      expect(transformer).toBeInstanceOf(TransformStream);
    });

    it("processes chunks through the stream", async () => {
      const store = createMockSignatureStore();
      const transformer = createStreamingTransformer(store, defaultCallbacks);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      
      const input = encoder.encode("data: [DONE]\n");
      const outputChunks: Uint8Array[] = [];
      
      const writer = transformer.writable.getWriter();
      const reader = transformer.readable.getReader();
      
      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) outputChunks.push(value);
        }
      })();
      
      await writer.write(input);
      await writer.close();
      await readPromise;
      
      const output = outputChunks.map(chunk => decoder.decode(chunk)).join("");
      expect(output).toContain("[DONE]");
    });
  });

  describe("prepareAntigravityRequest", () => {
    const mockAccessToken = "test-token";
    const mockProjectId = "test-project";

    it("returns unchanged request for non-generative-language URLs", () => {
      const result = prepareAntigravityRequest(
        "https://example.com/api",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
      expect(result.request).toBe("https://example.com/api");
    });

    it("returns unchanged request for URLs without model pattern", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1/models",
        { method: "POST" },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("intercepts Request object inputs for generative language URLs", async () => {
      const request = new Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=secret",
        {
          method: "POST",
          headers: { "x-goog-api-key": "old-google-key" },
          body: JSON.stringify({ contents: [] }),
        },
      );

      const result = await prepareAntigravityRequest(
        request,
        undefined,
        mockAccessToken,
        mockProjectId,
      );

      const headers = result.init.headers as Headers;
      expect(result.request).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent");
      expect(headers.get("Authorization")).toBe("Bearer test-token");
      expect(headers.get("x-goog-api-key")).toBeNull();
      expect(result.init.method).toBe("POST");
      expect(JSON.parse(String(result.init.body))).toMatchObject({
        model: "gemini-pro",
        request: {
          contents: [],
        },
      });
    });

    it("merges Request headers with init headers while preserving init precedence", async () => {
      const request = new Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": "from-request",
          },
          body: JSON.stringify({ contents: [] }),
        },
      );

      const result = await prepareAntigravityRequest(
        request,
        { headers: { "x-request-id": "from-init" } },
        mockAccessToken,
        mockProjectId,
      );

      const headers = new Headers(result.init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-request-id")).toBe("from-init");
    });

    it("detects streaming from generateStreamContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(true);
    });

    it("detects non-streaming from generateContent action", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("sets Authorization header with Bearer token", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    });

it("removes API key headers", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        {
          method: "POST",
          body: JSON.stringify({ contents: [] }),
          headers: { "x-api-key": "old-key", "x-goog-api-key": "old-google-key" },
        },
        mockAccessToken,
        mockProjectId
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-goog-api-key")).toBeNull();
    });

    it("removes x-goog-user-project header for antigravity headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("removes x-goog-user-project header for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }), headers: { "x-goog-user-project": "my-project" } },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("x-goog-user-project")).toBeNull();
    });

    it("uses exact Code Assist headers for gemini-cli headerStyle", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      const headers = result.init.headers as Headers;
      expect(headers.get("User-Agent")).toBe("google-api-nodejs-client/9.15.1");
      expect(headers.get("X-Goog-Api-Client")).toBe("gl-node/22.17.0");
      expect(headers.get("Client-Metadata")).toBe("ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI");
    });

    it("builds gemini-cli wrapped body without antigravity-only fields", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
        mockAccessToken,
        "",
        undefined,
        "gemini-cli"
      );
      const parsed = JSON.parse(result.init.body as string);
      expect(parsed).toHaveProperty("project", "");
      expect(parsed).toHaveProperty("model");
      expect(parsed).toHaveProperty("request");
      expect(parsed.requestType).toBeUndefined();
      expect(parsed.userAgent).toBeUndefined();
      expect(parsed.requestId).toBeUndefined();
    });

    it("identifies Claude models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-20250514:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("claude");
    });

    it("identifies Gemini models correctly", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.effectiveModel).toContain("gemini");
    });

    it("uses custom endpoint override", () => {
      const customEndpoint = "https://custom.api.com";
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        customEndpoint
      );
      expect(result.endpoint).toContain(customEndpoint);
    });

    it("handles wrapped Antigravity body format", () => {
      const wrappedBody = {
        project: "my-project",
        request: { contents: [{ parts: [{ text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles unwrapped body format", () => {
      const unwrappedBody = {
        contents: [{ parts: [{ text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    // Finding #8: lock in current wrapped-branch behavior (project+request shape).
    // The wrapped branch sets the model, attaches a stable sessionId, and
    // intentionally SKIPS JSON-schema cleaning / tool hardening on request.tools.
    it("preserves wrapper, sets model, and attaches a stable sessionId (wrapped Claude)", () => {
      const wrappedBody = {
        project: "projects/my-proj",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        },
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const parsed = JSON.parse(result.init.body as string);
      // Wrapper structure preserved (not converted to unwrapped).
      expect(parsed.project).toBe("projects/my-proj");
      expect(parsed.request).toBeDefined();
      // Model is stamped onto the wrapped body and matches effectiveModel.
      expect(typeof parsed.model).toBe("string");
      expect(parsed.model).toBe(result.effectiveModel);
      // A stable session id is attached to the inner request and surfaced on the result.
      expect(typeof result.sessionId).toBe("string");
      expect(parsed.request.sessionId).toBe(result.sessionId);
    });

    it("does NOT clean tool JSON schemas in the wrapped branch", () => {
      // A `const` keyword is normally rewritten to enum by cleanJSONSchemaForAntigravity.
      // The wrapped branch skips schema cleaning, so it must pass through unchanged.
      const wrappedBody = {
        project: "my-project",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: "do_thing",
                  parameters: {
                    type: "object",
                    properties: { mode: { const: "fast" } },
                  },
                },
              ],
            },
          ],
        },
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const parsed = JSON.parse(result.init.body as string);
      const params =
        parsed.request.tools[0].functionDeclarations[0].parameters;
      expect(params.properties.mode.const).toBe("fast");
    });

    it("does not add Claude auto-caching to wrapped request by default", () => {
      const wrappedBody = {
        project: "my-project",
        request: { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(wrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("does not add Claude auto-caching to unwrapped request by default", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toBeUndefined();
    });

    it("adds Claude auto-caching when enabled", () => {
      const unwrappedBody = {
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
      };
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-3-7-sonnet:generateContent",
        { method: "POST", body: JSON.stringify(unwrappedBody) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "antigravity",
        false,
        { claudePromptAutoCaching: true },
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.cache_control).toEqual({ type: "ephemeral" });
    });

    it("strips Claude thinking blocks (unwrapped)", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-unwrapped",
                    thoughtSignature: "f".repeat(MIN_SIGNATURE_LENGTH + 8),
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingParts = parts.filter((part) =>
        part.thought === true
        || part.type === "thinking"
        || part.type === "redacted_thinking"
        || part.type === "reasoning",
      );

      expect(thinkingParts).toHaveLength(0);
    });

    it("strips Claude thinking blocks (wrapped)", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            project: "my-project",
            request: {
              contents: [
                {
                  role: "model",
                  parts: [
                    {
                      thought: true,
                      text: "foreign-thought-wrapped",
                      thoughtSignature: "w".repeat(MIN_SIGNATURE_LENGTH + 8),
                    },
                    { functionCall: { name: "weather", args: {} } },
                  ],
                },
              ],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingParts = parts.filter((part) =>
        part.thought === true
        || part.type === "thinking"
        || part.type === "redacted_thinking"
        || part.type === "reasoning",
      );

      expect(thinkingParts).toHaveLength(0);
    });

    it("does not forward a foreign Gemini thoughtSignature to Claude", () => {
      const foreignSignature = "x".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "model",
                parts: [
                  {
                    thought: true,
                    text: "foreign-thought-keep-true",
                    thoughtSignature: foreignSignature,
                  },
                  { functionCall: { name: "weather", args: {} } },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      const parts = wrapped.request.contents[0].parts as Array<Record<string, unknown>>;
      const thinkingBlock = parts.find((part) =>
        part.thought === true || part.type === "thinking" || part.type === "redacted_thinking",
      );
      const signature = typeof thinkingBlock?.signature === "string"
        ? thinkingBlock.signature
        : thinkingBlock?.thoughtSignature;

      expect(JSON.stringify(wrapped)).not.toContain(foreignSignature);
      if (thinkingBlock) {
        expect(signature).toBe(SKIP_THOUGHT_SIGNATURE);
      }
    });

    it("strips signed thinking blocks from Claude messages[]", () => {
      const foreignSignature = "y".repeat(MIN_SIGNATURE_LENGTH + 8);
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/claude-opus-4-6-thinking:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "thinking",
                    thinking: "foreign-message-thinking",
                    signature: foreignSignature,
                  },
                  {
                    type: "tool_use",
                    id: "tool-1",
                    name: "weather",
                    input: {},
                  },
                ],
              },
            ],
          }),
        },
        mockAccessToken,
        mockProjectId,
      );

      const wrapped = JSON.parse(result.init.body as string);
      const content = wrapped.request.messages[0].content as Array<Record<string, unknown>>;
      const thinkingBlock = content.find((block) => block.type === "thinking" || block.type === "redacted_thinking");

      expect(thinkingBlock).toBeUndefined();
      expect(JSON.stringify(content)).not.toContain(foreignSignature);
    });

    it("returns requestedModel matching URL model", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.requestedModel).toBe("gemini-2.5-flash");
    });

    it("handles empty body gracefully", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({}) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("handles minimal valid JSON body", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId
      );
      expect(result.streaming).toBe(false);
    });

    it("removes contents entries with empty or invalid parts", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [] },
              { role: "model", parts: [null, { text: "kept" }] },
              { role: "user", parts: null },
            ],
            systemInstruction: {
              role: "user",
              parts: [null, { text: "system kept" }],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.contents).toHaveLength(1);
      expect(wrapped.request.contents[0]).toEqual({
        role: "model",
        parts: [{ text: "kept" }],
      });
      expect(wrapped.request.systemInstruction.parts).toEqual([{ text: "system kept" }]);
    });

    it("drops systemInstruction when all parts are invalid", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            systemInstruction: {
              role: "user",
              parts: [null],
            },
          }),
        },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli",
      );

      const wrapped = JSON.parse(result.init.body as string);
      expect(wrapped.request.systemInstruction).toBeUndefined();
    });

    it("preserves headerStyle in response", () => {
      const result = prepareAntigravityRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        { method: "POST", body: JSON.stringify({ contents: [] }) },
        mockAccessToken,
        mockProjectId,
        undefined,
        "gemini-cli"
      );
      expect(result.headerStyle).toBe("gemini-cli");
    });

    describe("Issue #103: model name transformation during quota fallback", () => {
      it("transforms gemini-3-flash-preview to gemini-3-flash for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-flash");
      });

      it("transforms gemini-3-pro-preview to gemini-3-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3-pro-low");
      });

      it("transforms gemini-3.1-pro-preview to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3.1-pro-preview-customtools to gemini-3.1-pro-low for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-low");
      });

      it("transforms gemini-3.8-flash to its default high backend id for antigravity headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.8-flash-high");
        const wrapped = JSON.parse(result.init.body as string);
        expect(wrapped.model).toBe("gemini-3.8-flash-high");
        expect(wrapped.request.generationConfig.thinkingConfig).toMatchObject({
          thinkingLevel: "high",
          includeThoughts: true,
        });
      });

      it("maps the default backend id for wrapped gemini-3.8-flash requests", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          {
            method: "POST",
            body: JSON.stringify({
              project: "existing-project",
              request: { contents: [] },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.8-flash-high");
        const wrapped = JSON.parse(result.init.body as string);
        expect(wrapped.request.generationConfig.thinkingConfig).toMatchObject({
          thinkingLevel: "high",
          includeThoughts: true,
        });
      });

      it("moves the gemini-3.8-flash backend id with an explicit thinkingLevel", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          {
            method: "POST",
            body: JSON.stringify({
              contents: [],
              generationConfig: {
                thinkingConfig: {
                  thinkingLevel: "medium",
                  includeThoughts: false,
                },
              },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.8-flash-medium");
        const wrapped = JSON.parse(result.init.body as string);
        expect(wrapped.model).toBe("gemini-3.8-flash-medium");
        expect(wrapped.request.generationConfig.thinkingConfig).toMatchObject({
          thinkingLevel: "medium",
          includeThoughts: false,
        });
      });

      it("maps a providerOptions low variant for gemini-3.8-flash to the low backend id", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          {
            method: "POST",
            body: JSON.stringify({
              contents: [],
              providerOptions: {
                google: {
                  thinkingLevel: "low",
                },
              },
            }),
          },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-3.8-flash-low");
        const wrapped = JSON.parse(result.init.body as string);
        expect(wrapped.model).toBe("gemini-3.8-flash-low");
        expect(wrapped.request.generationConfig.thinkingConfig).toMatchObject({
          thinkingLevel: "low",
          includeThoughts: true,
        });
      });

      it("transforms gemini-3.1-pro-low to gemini-3.1-pro (bare) for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-low:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro");
      });

      it("strips legacy gemini-3.1-pro-preview to bare name for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro");
      });

      it("keeps gemini-3.8-flash bare for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.8-flash");
        const wrapped = JSON.parse(result.init.body as string);
        expect(wrapped.request.generationConfig.thinkingConfig).toMatchObject({
          thinkingLevel: "high",
          includeThoughts: true,
        });
      });

      it("keeps gemini-3.1-pro-preview-customtools unchanged for gemini-cli headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview-customtools:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "gemini-cli"
        );
        expect(result.effectiveModel).toBe("gemini-3.1-pro-preview-customtools");
      });

      it("keeps non-Gemini-3 models unchanged regardless of headerStyle", () => {
        const result = prepareAntigravityRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { method: "POST", body: JSON.stringify({ contents: [] }) },
          mockAccessToken,
          mockProjectId,
          undefined,
          "antigravity"
        );
        expect(result.effectiveModel).toBe("gemini-2.5-flash");
      });
    });
  });

  describe("transformAntigravityResponse", () => {
    it("passes Google's retry delay on as Retry-After on a 429", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Resource exhausted",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12.5s" }],
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );

      const transformed = await transformAntigravityResponse(response, false, null, "gemini-3.1-pro");

      expect(transformed.status).toBe(429);
      expect(transformed.headers.get("Retry-After")).toBe("13");
      expect(transformed.headers.get("retry-after-ms")).toBe("12500");
    });

    it("drops content-length and content-encoding of the rewritten body", async () => {
      const response = new Response(
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } }),
        {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "9999", "content-encoding": "gzip" },
        },
      );

      const transformed = await transformAntigravityResponse(response, false, null, "gemini-3.1-pro");

      expect(transformed.headers.get("content-length")).toBeNull();
      expect(transformed.headers.get("content-encoding")).toBeNull();
      expect(JSON.parse(await transformed.text()).candidates[0].content.parts[0].text).toBe("hi");
    });

    it("injects [ThinkingResolution] details when debug_tui is enabled", async () => {
      initializeDebug({
        ...DEFAULT_CONFIG,
        debug: false,
        debug_tui: true,
      });

      const response = new Response(
        JSON.stringify({
          error: {
            code: 500,
            message: "Upstream error",
            status: "INTERNAL",
          },
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        false,
        undefined,
        "gemini-2.5-pro",
        "test-project",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
        "gemini-2.5-pro",
        "session-1",
        0,
        "summary",
        undefined,
        [
          "status=500 INTERNAL",
          "endpoint=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent",
          "account=test@example.com",
        ],
      );

      const bodyText = await transformed.text();
      expect(bodyText).toContain("[ThinkingResolution]");
      expect(bodyText).toContain("status=500 INTERNAL");
      expect(bodyText).toContain("endpoint=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent");
      expect(bodyText).toContain("account=test@example.com");

      initializeDebug(DEFAULT_CONFIG);
    });

    it("does not misclassify generic INVALID_ARGUMENT as thinking recovery from debug metadata", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      const transformed = await transformAntigravityResponse(
        response,
        true,
        undefined,
        "antigravity-claude-opus-4-6-thinking",
        "test-project",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "claude-opus-4-6-thinking",
        "session-1",
        0,
        "expected=1 found=0",
      );

      await expect(transformed.text()).resolves.toContain("Request contains an invalid argument.");
    });

    it("rethrows THINKING_RECOVERY_NEEDED for outer retry handling", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Thinking must start with a thinking block before tool use.",
            status: "INVALID_ARGUMENT",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );

      await expect(
        transformAntigravityResponse(
          response,
          true,
          undefined,
          "antigravity-claude-opus-4-6-thinking",
          "test-project",
          "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
          "claude-opus-4-6-thinking",
          "session-1",
        ),
      ).rejects.toMatchObject({ message: "THINKING_RECOVERY_NEEDED" });
    });
  });
});

describe("Gemini-3 thought signature restore (sanitizeRequestPayloadForAntigravity)", () => {
  // Loop ②: For multi-turn Gemini-3 function calling, the response side caches the
  // model's thoughtSignature, but the request side previously had no Gemini path to
  // restore it — it always stamped the sentinel. Losing the signed chain-of-thought
  // every turn made the model re-derive the same plan forever (the "Phase 3P" loop).
  it("restores the cached thoughtSignature onto the functionCall part instead of the sentinel", () => {
    const sessionKey = "gemini3-restore-spec";
    clearSignatureCache(sessionKey);
    const realSignature = "g".repeat(MIN_SIGNATURE_LENGTH + 12);
    const thoughtText = "I should search the workspace for Phase 3P.";
    cacheSignature(sessionKey, thoughtText, realSignature);

    const payload: any = {
      contents: [
        {
          role: "model",
          parts: [
            { thought: true, text: thoughtText },
            { functionCall: { name: "grep", args: { pattern: "Phase 3P" } } },
          ],
        },
      ],
    };

    sanitizeRequestPayloadForAntigravity(payload, { sessionKey, getSignature: getCachedSignature });

    const fnPart = payload.contents[0].parts.find((p: any) => p.functionCall);
    expect(fnPart.thoughtSignature).toBe(realSignature);
    expect(fnPart.thought_signature).toBe(realSignature);
    expect(fnPart.thoughtSignature).not.toBe(SKIP_THOUGHT_SIGNATURE);
  });

  it("falls back to the sentinel when no signature is cached (preserves today's behavior)", () => {
    const sessionKey = "gemini3-restore-miss-spec";
    clearSignatureCache(sessionKey);

    const payload: any = {
      contents: [
        {
          role: "model",
          parts: [
            { thought: true, text: "uncached reasoning" },
            { functionCall: { name: "grep", args: {} } },
          ],
        },
      ],
    };

    sanitizeRequestPayloadForAntigravity(payload, { sessionKey, getSignature: getCachedSignature });

    const fnPart = payload.contents[0].parts.find((p: any) => p.functionCall);
    expect(fnPart.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });

  it("still stamps the sentinel when no restore options are provided (Claude/legacy path)", () => {
    const payload: any = {
      contents: [
        {
          role: "model",
          parts: [
            { thought: true, text: "no restore opts" },
            { functionCall: { name: "grep", args: {} } },
          ],
        },
      ],
    };

    sanitizeRequestPayloadForAntigravity(payload);

    const fnPart = payload.contents[0].parts.find((p: any) => p.functionCall);
    expect(fnPart.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);
  });
});

describe("signatureCacheProjectKey (Defect 2: project-independent key for Gemini-3)", () => {
  // Gemini-3 thought signatures are content-derived, not project-scoped, and the
  // API only strictly validates the current turn (verified via API docs + log
  // forensics). Keeping the signature cache key project-independent lets reasoning
  // continuity survive quota-driven account/project switches — otherwise the key
  // changes on switch, the cache misses, and the model re-plans the same step.
  it("drops the project component for Gemini-3 so the key is identical across projects", () => {
    expect(signatureCacheProjectKey("gemini-3-pro", "project-A")).toBeUndefined();
    expect(signatureCacheProjectKey("antigravity-gemini-3-flash", "project-B")).toBeUndefined();

    const keyA = buildSignatureSessionKey(
      "sess",
      "gemini-3-pro",
      "conv-1",
      signatureCacheProjectKey("gemini-3-pro", "project-A"),
    );
    const keyB = buildSignatureSessionKey(
      "sess",
      "gemini-3-pro",
      "conv-1",
      signatureCacheProjectKey("gemini-3-pro", "project-B"),
    );
    expect(keyA).toBe(keyB);
  });

  it("preserves the project component for Claude (unchanged partitioning)", () => {
    expect(signatureCacheProjectKey("claude-opus-4-6-thinking", "project-A")).toBe("project-A");
    expect(signatureCacheProjectKey("gemini-2.5-pro", "project-A")).toBe("project-A");
  });
});

// Finding #3: per-session thinking-dedup state must be scoped by sessionId so
// identical thinking text in a SECOND session is not cross-suppressed, and the
// map stays bounded (old sessions evicted FIFO).
describe("getDisplayedThinkingHashes (per-session dedup scoping)", () => {
  it("returns the same Set instance for the same sessionId", () => {
    const a = getDisplayedThinkingHashes("session-A");
    const b = getDisplayedThinkingHashes("session-A");
    expect(a).toBe(b);
  });

  it("returns distinct Sets for different sessions (no cross-session sharing)", () => {
    const a = getDisplayedThinkingHashes("session-one");
    const b = getDisplayedThinkingHashes("session-two");
    expect(a).not.toBe(b);

    // A hash displayed in session-one must NOT suppress the same text in session-two.
    a!.add("hash-xyz");
    expect(a!.has("hash-xyz")).toBe(true);
    expect(b!.has("hash-xyz")).toBe(false);
  });

  it("returns undefined when no sessionId is available", () => {
    expect(getDisplayedThinkingHashes(undefined)).toBeUndefined();
    expect(getDisplayedThinkingHashes("")).toBeUndefined();
  });

  it("evicts oldest sessions once the cap is exceeded (bounded memory)", () => {
    // Insert well beyond the cap (50); the first-seen session must be evicted.
    const first = getDisplayedThinkingHashes("evict-session-0");
    first!.add("marker");
    for (let i = 1; i <= 60; i++) {
      getDisplayedThinkingHashes(`evict-session-${i}`);
    }
    // Re-fetching the evicted session yields a fresh empty Set.
    const refetched = getDisplayedThinkingHashes("evict-session-0");
    expect(refetched!.has("marker")).toBe(false);
  });
});

describe("Effort-in-id Flash request pipeline", () => {
  const mockAccessToken = "test-token";
  const mockProjectId = "test-project";

  const bodyFor = async (model: string, generationConfig: Record<string, unknown>) => {
    const request = new Request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig,
        }),
      },
    );
    const result = await prepareAntigravityRequest(
      request,
      undefined,
      mockAccessToken,
      mockProjectId,
    );
    return JSON.parse(String(result.init.body));
  };

  // The backend accepts temperature/topP/topK on the effort-in-id Flash ids, and
  // Google's docs only advise keeping temperature at its 1.0 default — so the
  // pipeline must forward them untouched.
  it.each(["antigravity-gemini-3.8-flash-high", "antigravity-gemini-3.8-flash-low"])(
    "forwards temperature/topP/topK unchanged for %s",
    async (model) => {
      const body = await bodyFor(model, {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 1024,
      });

      const sent = body.request?.generationConfig ?? body.generationConfig ?? {};
      expect(sent.temperature).toBe(0.7);
      expect(sent.topP).toBe(0.95);
      expect(sent.topK).toBe(40);
      expect(sent.maxOutputTokens).toBe(1024);
    },
  );
});

describe("restoreGeminiMaxOutputTokens", () => {
  const { restoreGeminiMaxOutputTokens } = __testExports as {
    restoreGeminiMaxOutputTokens: (
      payload: Record<string, unknown>,
      model: string,
    ) => void;
  };

  it("restores the model's real limit when OpenCode's global cap is present", () => {
    // OpenCode computes maxOutputTokens as Math.min(limit.output, 32000), so a
    // 3.8 Flash request arrives capped at 32000 despite a 65536 limit.
    const payload = { generationConfig: { maxOutputTokens: 32000, temperature: 0.5 } };
    restoreGeminiMaxOutputTokens(payload, "gemini-3.8-flash-high");
    expect(payload.generationConfig).toEqual({
      maxOutputTokens: 65536,
      temperature: 0.5,
    });
  });

  it("uses the Pro line's 65535 rather than a single hardcoded number", () => {
    const payload = { generationConfig: { maxOutputTokens: 32000 } };
    restoreGeminiMaxOutputTokens(payload, "gemini-3.1-pro-high");
    expect(payload.generationConfig).toEqual({ maxOutputTokens: 65535 });
  });

  it("leaves a deliberately smaller budget alone", () => {
    // Only the exact cap is treated as OpenCode's doing; a caller asking for a
    // short response must keep it.
    const payload = { generationConfig: { maxOutputTokens: 512 } };
    restoreGeminiMaxOutputTokens(payload, "gemini-3.8-flash-high");
    expect(payload.generationConfig).toEqual({ maxOutputTokens: 512 });
  });

  it("leaves a value at or above the limit alone", () => {
    const payload = { generationConfig: { maxOutputTokens: 65536 } };
    restoreGeminiMaxOutputTokens(payload, "gemini-3.8-flash-high");
    expect(payload.generationConfig).toEqual({ maxOutputTokens: 65536 });
  });

  it("does not touch Claude models, which have their own thinking-aware path", () => {
    const payload = { generationConfig: { maxOutputTokens: 32000 } };
    restoreGeminiMaxOutputTokens(payload, "claude-sonnet-4-6");
    expect(payload.generationConfig).toEqual({ maxOutputTokens: 32000 });
  });

  it("does nothing when there is no generationConfig", () => {
    const payload: Record<string, unknown> = { contents: [] };
    expect(() => restoreGeminiMaxOutputTokens(payload, "gemini-3.8-flash-high")).not.toThrow();
    expect(payload).toEqual({ contents: [] });
  });
});

describe("Gemini output budget in the request pipeline", () => {
  const bodyFor = async (model: string, generationConfig: Record<string, unknown>) => {
    const request = new Request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig,
        }),
      },
    );
    const result = await prepareAntigravityRequest(request, undefined, "t", "p");
    const parsed = JSON.parse(String(result.init.body));
    return parsed.request?.generationConfig ?? parsed.generationConfig ?? {};
  };

  it("sends 65536 for 3.8 Flash instead of OpenCode's 32000 cap", async () => {
    const sent = await bodyFor("antigravity-gemini-3.8-flash-high", {
      maxOutputTokens: 32000,
    });
    expect(sent.maxOutputTokens).toBe(65536);
  });
});
