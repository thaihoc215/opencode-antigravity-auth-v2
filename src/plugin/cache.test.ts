import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cacheSignature,
  getCachedSignature,
  clearSignatureCache,
} from "./cache";

describe("Signature Cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSignatureCache();
  });

  afterEach(() => {
    clearSignatureCache();
  });

  describe("cacheSignature", () => {
    it("caches a signature for session and text", () => {
      cacheSignature("session1", "thinking text", "sig123");
      const result = getCachedSignature("session1", "thinking text");
      expect(result).toBe("sig123");
    });

    it("does nothing when sessionId is empty", () => {
      cacheSignature("", "text", "sig");
      expect(getCachedSignature("", "text")).toBeUndefined();
    });

    it("does nothing when text is empty", () => {
      cacheSignature("session", "", "sig");
      expect(getCachedSignature("session", "")).toBeUndefined();
    });

    it("does nothing when signature is empty", () => {
      cacheSignature("session", "text", "");
      expect(getCachedSignature("session", "text")).toBeUndefined();
    });

    it("stores multiple signatures per session", () => {
      cacheSignature("session1", "text1", "sig1");
      cacheSignature("session1", "text2", "sig2");

      expect(getCachedSignature("session1", "text1")).toBe("sig1");
      expect(getCachedSignature("session1", "text2")).toBe("sig2");
    });

    it("stores signatures for different sessions independently", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      expect(getCachedSignature("session1", "text")).toBe("sig1");
      expect(getCachedSignature("session2", "text")).toBe("sig2");
    });
  });

  describe("getCachedSignature", () => {
    it("returns undefined when session not found", () => {
      expect(getCachedSignature("unknown", "text")).toBeUndefined();
    });

    it("returns undefined when text not found in session", () => {
      cacheSignature("session", "known-text", "sig");
      expect(getCachedSignature("session", "unknown-text")).toBeUndefined();
    });

    it("returns undefined when sessionId is empty", () => {
      expect(getCachedSignature("", "text")).toBeUndefined();
    });

    it("returns undefined when text is empty", () => {
      expect(getCachedSignature("session", "")).toBeUndefined();
    });

    it("returns undefined when signature is expired", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      cacheSignature("session", "text", "sig");

      // Advance time past TTL (1 hour = 3600000ms)
      vi.setSystemTime(new Date(3600001));

      expect(getCachedSignature("session", "text")).toBeUndefined();
    });

    it("returns signature when not expired", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      cacheSignature("session", "text", "sig");

      // Advance time but stay within TTL
      vi.setSystemTime(new Date(3599999));

      expect(getCachedSignature("session", "text")).toBe("sig");
    });
  });

  describe("clearSignatureCache", () => {
    it("clears all signature cache when no argument provided", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      clearSignatureCache();

      expect(getCachedSignature("session1", "text")).toBeUndefined();
      expect(getCachedSignature("session2", "text")).toBeUndefined();
    });

    it("clears specific session from cache", () => {
      cacheSignature("session1", "text", "sig1");
      cacheSignature("session2", "text", "sig2");

      clearSignatureCache("session1");

      expect(getCachedSignature("session1", "text")).toBeUndefined();
      expect(getCachedSignature("session2", "text")).toBe("sig2");
    });
  });

  describe("whole-session eviction", () => {
    it("evicts an entire session whose newest entry is older than the TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      cacheSignature("stale-session", "text", "sig");
      expect(getCachedSignature("stale-session", "text")).toBe("sig");

      // Advance beyond TTL (1 hour = 3600000ms), then touch via a different session.
      vi.setSystemTime(new Date(3600001));
      cacheSignature("fresh-session", "text2", "sig2");

      // The stale session's map should have been swept entirely.
      expect(getCachedSignature("stale-session", "text")).toBeUndefined();
      expect(getCachedSignature("fresh-session", "text2")).toBe("sig2");
    });

    it("caps the number of session maps, FIFO-evicting the oldest-touched", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      // Create more sessions than the cap (50), staggering their touch times so
      // the earliest sessions are the oldest-touched. Stay within the TTL window.
      const total = 55;
      for (let i = 0; i < total; i++) {
        vi.setSystemTime(new Date(i * 1000));
        cacheSignature(`session-${i}`, "text", `sig-${i}`);
      }

      // The oldest sessions should be evicted; the most recent 50 remain.
      expect(getCachedSignature("session-0", "text")).toBeUndefined();
      expect(getCachedSignature("session-4", "text")).toBeUndefined();
      expect(getCachedSignature(`session-${total - 1}`, "text")).toBe(`sig-${total - 1}`);
    });
  });

  describe("cache eviction", () => {
    it("evicts entries when at capacity", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));

      // Fill cache with 100 entries (MAX_ENTRIES_PER_SESSION)
      for (let i = 0; i < 100; i++) {
        vi.setSystemTime(new Date(i * 1000)); // stagger timestamps
        cacheSignature("session", `text-${i}`, `sig-${i}`);
      }

      // Reset time to check entries
      vi.setSystemTime(new Date(100 * 1000));

      // Adding one more should trigger eviction
      cacheSignature("session", "new-text", "new-sig");

      // New entry should exist
      expect(getCachedSignature("session", "new-text")).toBe("new-sig");

      // Some old entries should have been evicted (oldest 25%)
      // Entry at index 0 (timestamp 0) should be evicted
      expect(getCachedSignature("session", "text-0")).toBeUndefined();
    });
  });
});
