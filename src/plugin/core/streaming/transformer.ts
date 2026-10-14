import type {
  SignatureStore,
  StreamingCallbacks,
  StreamingOptions,
  ThoughtBuffer,
} from './types';

/**
 * Upper bound on the number of thinking-text hashes retained per session.
 *
 * The per-session dedup Set is created (and its lifetime bounded) by
 * request.ts, but WITHIN a long-lived session the Set would otherwise grow for
 * every unique thinking chunk streamed. Cap it and FIFO-evict the oldest hash
 * (a Set iterates in insertion order, so the first entry is the oldest). 2000
 * hashes is far more than any single streamed turn produces, so dedup accuracy
 * for the active turn is unaffected.
 */
const MAX_SESSION_THINKING_HASHES = 2000;

/**
 * Adds a hash to a bounded per-session dedup Set, evicting the oldest entry
 * (insertion order) once the cap is exceeded.
 */
function addBoundedThinkingHash(hashes: Set<string>, hash: string): void {
  hashes.add(hash);
  if (hashes.size > MAX_SESSION_THINKING_HASHES) {
    const oldest = hashes.values().next().value;
    if (oldest !== undefined) {
      hashes.delete(oldest);
    }
  }
}

/**
 * Shorter thinking text is never treated as a repeat: a chunk like " " or
 * "Plan" legitimately recurs, and is too short to tell a re-send from a delta.
 */
const MIN_DEDUP_THINKING_CHARS = 64;

/**
 * Deduplicates one thinking part. Streams normally send deltas, which pass
 * through unchanged. Two kinds of re-send are trimmed:
 * - a part repeating everything already shown for this position, plus more
 *   (cumulative text): only the new tail is emitted;
 * - a substantial block identical to one already shown in this session.
 * Returns the text to emit, or null to drop the part.
 */
function dedupThinkingText(
  text: string,
  key: number,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): string | null {
  const shown = sentBuffer.get(key) ?? '';

  if (shown.length >= MIN_DEDUP_THINKING_CHARS && text.startsWith(shown)) {
    sentBuffer.set(key, text);
    const tail = text.slice(shown.length);
    return tail || null;
  }

  if (displayedThinkingHashes && text.length >= MIN_DEDUP_THINKING_CHARS) {
    const hash = hashString(text);
    if (displayedThinkingHashes.has(hash)) {
      return null;
    }
    addBoundedThinkingHash(displayedThinkingHashes, hash);
  }

  sentBuffer.set(key, shown + text);
  return text;
}

/**
 * Simple string hash for thinking deduplication.
 * Uses DJB2-like algorithm.
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); /* hash * 33 + c */
  }
  return (hash >>> 0).toString(16);
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();
  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => buffer.set(index, text),
    clear: () => buffer.clear(),
  };
}

export function transformStreamingPayload(
  payload: string,
  transformThinkingParts?: (response: unknown) => unknown,
): string {
  return payload
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:')) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          const transformed = transformThinkingParts
            ? transformThinkingParts(parsed.response)
            : parsed.response;
          return `data: ${JSON.stringify(transformed)}`;
        }
      } catch (_) {}
      return line;
    })
    .join('\n');
}

export function deduplicateThinkingText(
  response: unknown,
  sentBuffer: ThoughtBuffer,
  displayedThinkingHashes?: Set<string>,
): unknown {
  if (!response || typeof response !== 'object') return response;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    const newCandidates = resp.candidates.map((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return candidate;

      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return candidate;

      const newParts = content.parts.map((part: unknown) => {
        const p = part as Record<string, unknown>;

if (p.thought === true || p.type === 'thinking') {
          const fullText = (p.text || p.thinking || '') as string;
          if (!fullText) {
            return part;
          }
          const text = dedupThinkingText(fullText, index, sentBuffer, displayedThinkingHashes);
          if (text === null) {
            return null;
          }
          return text === fullText ? part : { ...p, text, thinking: text };
        }
        return part;
      });

      const filteredParts = newParts.filter((p) => p !== null);

      return {
        ...cand,
        content: { ...content, parts: filteredParts },
      };
    });

    return { ...resp, candidates: newCandidates };
  }

  if (Array.isArray(resp.content)) {
    let thinkingIndex = 0;
    const newContent = resp.content.map((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const fullText = (b.thinking || b.text || '') as string;
        const key = thinkingIndex++;
        if (!fullText) {
          return block;
        }
        const text = dedupThinkingText(fullText, key, sentBuffer, displayedThinkingHashes);
        if (text === null) {
          return null;
        }
        return text === fullText ? block : { ...b, thinking: text, text };
      }
      return block;
    });

    const filteredContent = newContent.filter((b) => b !== null);
    return { ...resp, content: filteredContent };
  }

  return response;
}

export function transformSseLine(
  line: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  sentThinkingBuffer: ThoughtBuffer,
  callbacks: StreamingCallbacks,
  options: StreamingOptions,
  debugState: { injected: boolean },
): string {
  if (!line.startsWith('data:')) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }

  try {
    const parsed = JSON.parse(json) as { response?: unknown };
    if (parsed.response !== undefined) {
      if (options.cacheSignatures && options.signatureSessionKey) {
        cacheThinkingSignaturesFromResponse(
          parsed.response,
          options.signatureSessionKey,
          signatureStore,
          thoughtBuffer,
          callbacks.onCacheSignature,
        );
      }

      let response: unknown = deduplicateThinkingText(
        parsed.response,
        sentThinkingBuffer,
        options.displayedThinkingHashes
      );

      if (options.debugText && callbacks.onInjectDebug && !debugState.injected) {
        response = callbacks.onInjectDebug(response, options.debugText);
        debugState.injected = true;
      }
      // Note: onInjectSyntheticThinking removed - keep_thinking now uses debugText path

      const transformed = callbacks.transformThinkingParts
        ? callbacks.transformThinkingParts(response)
        : response;
      return `data: ${JSON.stringify(transformed)}`;
    }
  } catch (_) {}
  return line;
}

export function cacheThinkingSignaturesFromResponse(
  response: unknown,
  signatureSessionKey: string,
  signatureStore: SignatureStore,
  thoughtBuffer: ThoughtBuffer,
  onCacheSignature?: (sessionKey: string, text: string, signature: string) => void,
): void {
  if (!response || typeof response !== 'object') return;

  const resp = response as Record<string, unknown>;

  if (Array.isArray(resp.candidates)) {
    resp.candidates.forEach((candidate: unknown, index: number) => {
      const cand = candidate as Record<string, unknown> | null;
      if (!cand?.content) return;
      const content = cand.content as Record<string, unknown>;
      if (!Array.isArray(content.parts)) return;

      content.parts.forEach((part: unknown) => {
        const p = part as Record<string, unknown>;
        if (p.thought === true || p.type === 'thinking') {
          const text = (p.text || p.thinking || '') as string;
          if (text) {
            const current = thoughtBuffer.get(index) ?? '';
            thoughtBuffer.set(index, current + text);
          }
        }

        if (p.thoughtSignature) {
          const fullText = thoughtBuffer.get(index) ?? '';
          if (fullText) {
            const signature = p.thoughtSignature as string;
            onCacheSignature?.(signatureSessionKey, fullText, signature);
            signatureStore.set(signatureSessionKey, { text: fullText, signature });
          }
        }
      });
    });
  }

  if (Array.isArray(resp.content)) {
    // Use thoughtBuffer to accumulate thinking text across SSE events
    // Claude streams thinking content and signature in separate events
    const CLAUDE_BUFFER_KEY = 0; // Use index 0 for Claude's single-stream content
    resp.content.forEach((block: unknown) => {
      const b = block as Record<string, unknown> | null;
      if (b?.type === 'thinking') {
        const text = (b.thinking || b.text || '') as string;
        if (text) {
          const current = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
          thoughtBuffer.set(CLAUDE_BUFFER_KEY, current + text);
        }
      }
      if (b?.signature) {
        const fullText = thoughtBuffer.get(CLAUDE_BUFFER_KEY) ?? '';
        if (fullText) {
          const signature = b.signature as string;
          onCacheSignature?.(signatureSessionKey, fullText, signature);
          signatureStore.set(signatureSessionKey, { text: fullText, signature });
        }
      }
    });
  }
}

export function createStreamingTransformer(
  signatureStore: SignatureStore,
  callbacks: StreamingCallbacks,
  options: StreamingOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  // Text of the line still being received, in pieces: joining only once the
  // line ends keeps a long line arriving in many chunks linear, not quadratic.
  let pending: string[] = [];
  const thoughtBuffer = createThoughtBuffer();
  const sentThinkingBuffer = createThoughtBuffer();
  const debugState = { injected: false };
  let hasSeenUsageMetadata = false;

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        if (text) pending.push(text);
        return;
      }

      pending.push(text.slice(0, lastNewline));
      const lines = pending.join('').split('\n');
      const rest = text.slice(lastNewline + 1);
      pending = rest ? [rest] : [];

      for (const line of lines) {
        // Quick check for usage metadata presence in the raw line
        if (line.includes('usageMetadata')) {
          hasSeenUsageMetadata = true;
        }

        const transformedLine = transformSseLine(
          line,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine + '\n'));
      }
    },
    flush(controller) {
      pending.push(decoder.decode());
      const buffer = pending.join('');
      pending = [];

      if (buffer) {
        if (buffer.includes('usageMetadata')) {
          hasSeenUsageMetadata = true;
        }
        const transformedLine = transformSseLine(
          buffer,
          signatureStore,
          thoughtBuffer,
          sentThinkingBuffer,
          callbacks,
          options,
          debugState,
        );
        controller.enqueue(encoder.encode(transformedLine));
      }

      // Inject synthetic usage metadata if missing (fixes "Context % used: 0%" issue)
      if (!hasSeenUsageMetadata) {
        const syntheticUsage = {
          response: {
            usageMetadata: {
              promptTokenCount: 0,
              candidatesTokenCount: 0,
              totalTokenCount: 0,
            }
          }
        };
        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(syntheticUsage)}\n\n`));
      }
    },
  });
}
