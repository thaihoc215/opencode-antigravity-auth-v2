import { createHash } from "node:crypto";

// ============================================================================
// Thinking signature cache (in memory). Gemini 3 needs the signature of its
// previous thinking replayed on the next turn's function call; responses store
// it here and requests restore it.
// ============================================================================

interface SignatureEntry {
  signature: string;
  timestamp: number;
}

// Map: sessionId -> Map<textHash, SignatureEntry>
const signatureCache = new Map<string, Map<string, SignatureEntry>>();

// Tracks the last write/access time per session for whole-session lifecycle
// eviction. Kept in sync with signatureCache on every mutation.
const sessionLastTouched = new Map<string, number>();

// Cache entries expire after 1 hour
const SIGNATURE_CACHE_TTL_MS = 60 * 60 * 1000;

// Maximum entries per session to prevent memory bloat
const MAX_ENTRIES_PER_SESSION = 100;

// Maximum number of concurrent session maps to retain. Sessions never call an
// explicit teardown, so we cap the count and FIFO-evict the oldest-touched
// sessions to prevent unbounded growth from many short-lived sessions.
const MAX_SESSIONS = 50;

/**
 * Delete a session's memory cache and its lifecycle bookkeeping together.
 */
function dropSession(sessionId: string): void {
  signatureCache.delete(sessionId);
  sessionLastTouched.delete(sessionId);
}

/**
 * Record that a session was just written to or read from.
 */
function touchSession(sessionId: string, now: number): void {
  sessionLastTouched.set(sessionId, now);
}

/**
 * Opportunistically evict whole sessions:
 * 1. Drop sessions whose newest entry is older than the TTL.
 * 2. Cap the total number of sessions, FIFO-evicting the oldest-touched.
 * Runs on each cacheSignature/getCachedSignature call; O(sessions) and cheap.
 */
function evictStaleSessions(now: number): void {
  for (const [sessionId, touched] of sessionLastTouched) {
    if (now - touched > SIGNATURE_CACHE_TTL_MS) {
      dropSession(sessionId);
    }
  }

  if (signatureCache.size > MAX_SESSIONS) {
    const ordered = Array.from(sessionLastTouched.entries()).sort((a, b) => a[1] - b[1]);
    const removeCount = signatureCache.size - MAX_SESSIONS;
    for (let i = 0; i < removeCount && i < ordered.length; i++) {
      const entry = ordered[i];
      if (entry) {
        dropSession(entry[0]);
      }
    }
  }
}

// 16 hex chars = 64-bit key space; keeps memory bounded while making collisions extremely unlikely.
const SIGNATURE_TEXT_HASH_HEX_LEN = 16;

/**
 * Hashes text content into a stable, Unicode-safe key.
 *
 * Uses SHA-256 over UTF-8 bytes and truncates to keep memory usage bounded.
 */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_HEX_LEN);
}

/**
 * Caches a thinking signature for a given session and text.
 */
export function cacheSignature(sessionId: string, text: string, signature: string): void {
  if (!sessionId || !text || !signature) return;

  const now = Date.now();
  // Opportunistically evict whole sessions that have gone stale before adding more.
  evictStaleSessions(now);

  const textHash = hashText(text);

  // Write to memory cache
  let sessionMemCache = signatureCache.get(sessionId);
  if (!sessionMemCache) {
    sessionMemCache = new Map();
    signatureCache.set(sessionId, sessionMemCache);
  }

  // Evict old entries if we're at capacity
  if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
    const now = Date.now();
    for (const [key, entry] of sessionMemCache.entries()) {
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(key);
      }
    }
    // If still at capacity, remove oldest entries
    if (sessionMemCache.size >= MAX_ENTRIES_PER_SESSION) {
      const entries = Array.from(sessionMemCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, Math.floor(MAX_ENTRIES_PER_SESSION / 4));
      for (const [key] of toRemove) {
        sessionMemCache.delete(key);
      }
    }
  }

  sessionMemCache.set(textHash, { signature, timestamp: now });
  touchSession(sessionId, now);

  // Enforce the session cap now that a (possibly new) session was written.
  evictStaleSessions(now);
}

/**
 * Retrieves a cached signature for a given session and text.
 * Returns undefined if not found or expired.
 */
export function getCachedSignature(sessionId: string, text: string): string | undefined {
  if (!sessionId || !text) return undefined;

  const now = Date.now();
  // Opportunistically sweep stale sessions on access.
  evictStaleSessions(now);

  const textHash = hashText(text);

  // Check memory cache first
  const sessionMemCache = signatureCache.get(sessionId);
  if (sessionMemCache) {
    const entry = sessionMemCache.get(textHash);
    if (entry) {
      // Check if expired
      if (now - entry.timestamp > SIGNATURE_CACHE_TTL_MS) {
        sessionMemCache.delete(textHash);
      } else {
        touchSession(sessionId, now);
        return entry.signature;
      }
    }
  }

  return undefined;
}

/**
 * Clears signature cache for a specific session or all sessions.
 */
export function clearSignatureCache(sessionId?: string): void {
  if (sessionId) {
    dropSession(sessionId);
  } else {
    signatureCache.clear();
    sessionLastTouched.clear();
  }
}
