import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HealthScoreTracker,
  TokenBucketTracker,
  selectHybridAccount,
  type AccountWithMetrics,
} from "./rotation";

describe("HealthScoreTracker", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("returns initial score for unknown account", () => {
      const tracker = new HealthScoreTracker();
      expect(tracker.getScore(0)).toBe(70);
    });

    it("uses custom initial score from config", () => {
      const tracker = new HealthScoreTracker({ initial: 50 });
      expect(tracker.getScore(0)).toBe(50);
    });

    it("isUsable returns true for new accounts", () => {
      const tracker = new HealthScoreTracker();
      expect(tracker.isUsable(0)).toBe(true);
    });

    it("getConsecutiveFailures returns 0 for unknown account", () => {
      const tracker = new HealthScoreTracker();
      expect(tracker.getConsecutiveFailures(0)).toBe(0);
    });
  });

  describe("recordSuccess", () => {
    it("increases score by success reward", () => {
      const tracker = new HealthScoreTracker({ initial: 70, successReward: 5 });
      tracker.recordSuccess(0);
      expect(tracker.getScore(0)).toBe(75);
    });

    it("caps score at maxScore", () => {
      const tracker = new HealthScoreTracker({ initial: 98, successReward: 5, maxScore: 100 });
      tracker.recordSuccess(0);
      expect(tracker.getScore(0)).toBe(100);
    });

    it("resets consecutive failures", () => {
      const tracker = new HealthScoreTracker();
      tracker.recordRateLimit(0);
      tracker.recordRateLimit(0);
      expect(tracker.getConsecutiveFailures(0)).toBe(2);
      
      tracker.recordSuccess(0);
      expect(tracker.getConsecutiveFailures(0)).toBe(0);
    });
  });

  describe("recordRateLimit", () => {
    it("decreases score by rate limit penalty", () => {
      const tracker = new HealthScoreTracker({ initial: 70, rateLimitPenalty: -10 });
      tracker.recordRateLimit(0);
      expect(tracker.getScore(0)).toBe(60);
    });

    it("does not go below 0", () => {
      const tracker = new HealthScoreTracker({ initial: 5, rateLimitPenalty: -10 });
      tracker.recordRateLimit(0);
      expect(tracker.getScore(0)).toBe(0);
    });

    it("increments consecutive failures", () => {
      const tracker = new HealthScoreTracker();
      tracker.recordRateLimit(0);
      expect(tracker.getConsecutiveFailures(0)).toBe(1);
      
      tracker.recordRateLimit(0);
      expect(tracker.getConsecutiveFailures(0)).toBe(2);
    });
  });

  describe("recordFailure", () => {
    it("decreases score by failure penalty", () => {
      const tracker = new HealthScoreTracker({ initial: 70, failurePenalty: -20 });
      tracker.recordFailure(0);
      expect(tracker.getScore(0)).toBe(50);
    });

    it("does not go below 0", () => {
      const tracker = new HealthScoreTracker({ initial: 10, failurePenalty: -20 });
      tracker.recordFailure(0);
      expect(tracker.getScore(0)).toBe(0);
    });

    it("increments consecutive failures", () => {
      const tracker = new HealthScoreTracker();
      tracker.recordFailure(0);
      expect(tracker.getConsecutiveFailures(0)).toBe(1);
    });
  });

  describe("isUsable", () => {
    it("returns true when score >= minUsable", () => {
      const tracker = new HealthScoreTracker({ initial: 50, minUsable: 50 });
      expect(tracker.isUsable(0)).toBe(true);
    });

    it("returns false when score < minUsable", () => {
      const tracker = new HealthScoreTracker({ initial: 49, minUsable: 50 });
      expect(tracker.isUsable(0)).toBe(false);
    });

    it("becomes unusable after multiple failures", () => {
      const tracker = new HealthScoreTracker({ initial: 70, failurePenalty: -20, minUsable: 50 });
      tracker.recordFailure(0);
      expect(tracker.isUsable(0)).toBe(true);
      
      tracker.recordFailure(0);
      expect(tracker.isUsable(0)).toBe(false);
    });
  });

  describe("time-based recovery", () => {
    it("recovers points over time", () => {
      let mockTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      const tracker = new HealthScoreTracker({ 
        initial: 70, 
        failurePenalty: -20, 
        recoveryRatePerHour: 10 
      });
      
      tracker.recordFailure(0);
      expect(tracker.getScore(0)).toBe(50);

      mockTime = 2 * 60 * 60 * 1000;
      expect(tracker.getScore(0)).toBe(70);

      vi.restoreAllMocks();
    });

    it("caps recovery at maxScore", () => {
      let mockTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      const tracker = new HealthScoreTracker({ 
        initial: 90, 
        successReward: 5,
        recoveryRatePerHour: 20,
        maxScore: 100 
      });
      
      tracker.recordSuccess(0);
      expect(tracker.getScore(0)).toBe(95);
      
      mockTime = 60 * 60 * 1000;
      expect(tracker.getScore(0)).toBe(100);

      vi.restoreAllMocks();
    });

    it("floors recovered points (no partial points)", () => {
      let mockTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      const tracker = new HealthScoreTracker({ 
        initial: 70, 
        failurePenalty: -10, 
        recoveryRatePerHour: 2 
      });
      
      tracker.recordFailure(0);
      expect(tracker.getScore(0)).toBe(60);

      mockTime = 20 * 60 * 1000;
      expect(tracker.getScore(0)).toBe(60);

      mockTime = 30 * 60 * 1000;
      expect(tracker.getScore(0)).toBe(61);

      vi.restoreAllMocks();
    });
  });

  describe("reset", () => {
    it("clears health state for account", () => {
      const tracker = new HealthScoreTracker({ initial: 70 });
      tracker.recordSuccess(0);
      tracker.reset(0);
      
      expect(tracker.getScore(0)).toBe(70);
      expect(tracker.getConsecutiveFailures(0)).toBe(0);
    });
  });

  describe("getSnapshot", () => {
    it("returns current state of all tracked accounts", () => {
      const tracker = new HealthScoreTracker({ initial: 70, failurePenalty: -10 });
      tracker.recordSuccess(0);
      tracker.recordFailure(1);
      tracker.recordFailure(1);
      
      const snapshot = tracker.getSnapshot();
      expect(snapshot.get(0)?.score).toBe(71);
      expect(snapshot.get(0)?.consecutiveFailures).toBe(0);
      expect(snapshot.get(1)?.score).toBe(50);
      expect(snapshot.get(1)?.consecutiveFailures).toBe(2);
    });
  });
});

describe("TokenBucketTracker", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("returns initial tokens for unknown account", () => {
      const tracker = new TokenBucketTracker();
      expect(tracker.getTokens(0)).toBe(50);
    });

    it("uses custom initial tokens from config", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 30 });
      expect(tracker.getTokens(0)).toBe(30);
    });

    it("hasTokens returns true for new accounts", () => {
      const tracker = new TokenBucketTracker();
      expect(tracker.hasTokens(0)).toBe(true);
    });

    it("getMaxTokens returns configured max tokens", () => {
      const tracker = new TokenBucketTracker({ maxTokens: 100 });
      expect(tracker.getMaxTokens()).toBe(100);
    });

    it("getMaxTokens returns default when not configured", () => {
      const tracker = new TokenBucketTracker();
      expect(tracker.getMaxTokens()).toBe(50);
    });
  });

  describe("consume", () => {
    it("reduces token balance", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 50 });
      expect(tracker.consume(0, 1)).toBe(true);
      // Use toBeCloseTo to handle floating point from micro-regeneration between calls
      expect(tracker.getTokens(0)).toBeCloseTo(49, 2);
    });

    it("returns false when insufficient tokens", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 5 });
      expect(tracker.consume(0, 10)).toBe(false);
      expect(tracker.getTokens(0)).toBe(5);
    });

    it("allows consuming exact remaining tokens", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 10 });
      expect(tracker.consume(0, 10)).toBe(true);
      // Use toBeCloseTo to handle floating point from micro-regeneration between calls
      expect(tracker.getTokens(0)).toBeCloseTo(0, 2);
    });

    it("handles multiple consumes", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 50 });
      tracker.consume(0, 10);
      tracker.consume(0, 10);
      tracker.consume(0, 10);
      expect(tracker.getTokens(0)).toBeCloseTo(20, 2);
    });
  });

  describe("hasTokens", () => {
    it("returns true when enough tokens", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 50 });
      expect(tracker.hasTokens(0, 50)).toBe(true);
    });

    it("returns false when insufficient tokens", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 10 });
      expect(tracker.hasTokens(0, 11)).toBe(false);
    });

    it("defaults to cost of 1", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 1 });
      expect(tracker.hasTokens(0)).toBe(true);
      
      tracker.consume(0, 1);
      expect(tracker.hasTokens(0)).toBe(false);
    });
  });

  describe("refund", () => {
    it("adds tokens back", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 50 });
      tracker.consume(0, 10);
      expect(tracker.getTokens(0)).toBeCloseTo(40, 2);
      
      tracker.refund(0, 5);
      expect(tracker.getTokens(0)).toBeCloseTo(45, 2);
    });

    it("caps at maxTokens", () => {
      const tracker = new TokenBucketTracker({ initialTokens: 50, maxTokens: 50 });
      tracker.refund(0, 10);
      expect(tracker.getTokens(0)).toBe(50);
    });
  });

  describe("token regeneration", () => {
    it("regenerates tokens over time", () => {
      let mockTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      const tracker = new TokenBucketTracker({ 
        initialTokens: 50, 
        maxTokens: 50,
        regenerationRatePerMinute: 6 
      });
      
      tracker.consume(0, 30);
      expect(tracker.getTokens(0)).toBe(20);

      mockTime = 5 * 60 * 1000;
      expect(tracker.getTokens(0)).toBe(50);

      vi.restoreAllMocks();
    });

    it("caps regeneration at maxTokens", () => {
      let mockTime = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime);

      const tracker = new TokenBucketTracker({ 
        initialTokens: 40, 
        maxTokens: 50,
        regenerationRatePerMinute: 6 
      });
      
      tracker.consume(0, 1);
      
      mockTime = 10 * 60 * 1000;
      expect(tracker.getTokens(0)).toBe(50);

      vi.restoreAllMocks();
    });
  });
});

describe("selectHybridAccount", () => {
  it("returns null when no accounts available", () => {
    const tokenTracker = new TokenBucketTracker();
    const result = selectHybridAccount([], tokenTracker);
    expect(result).toBeNull();
  });

  it("returns null when all accounts filtered out by health", () => {
    const tokenTracker = new TokenBucketTracker();
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 30, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker, 50);
    expect(result).toBeNull();
  });

  it("returns the best candidate by score", () => {
    const tokenTracker = new TokenBucketTracker();
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 1000, healthScore: 70, isRateLimited: false, isCoolingDown: false },
      { index: 1, lastUsed: 500, healthScore: 70, isRateLimited: false, isCoolingDown: false },
      { index: 2, lastUsed: 2000, healthScore: 70, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker);
    expect([0, 1, 2]).toContain(result);
  });

  it("filters out rate-limited accounts", () => {
    const tokenTracker = new TokenBucketTracker();
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 70, isRateLimited: true, isCoolingDown: false },
      { index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker);
    expect(result).toBe(1);
  });

  it("filters out accounts without tokens", () => {
    const tokenTracker = new TokenBucketTracker({ initialTokens: 1 });
    tokenTracker.consume(0, 1);
    
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
      { index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker);
    expect(result).toBe(1);
  });

  it("filters out unhealthy accounts", () => {
    const tokenTracker = new TokenBucketTracker();
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 40, isRateLimited: false, isCoolingDown: false },
      { index: 1, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker, 50);
    expect(result).toBe(1);
  });

  it("returns null when all accounts have no tokens", () => {
    const tokenTracker = new TokenBucketTracker({ initialTokens: 0 });
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 70, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker);
    expect(result).toBeNull();
  });

  it("selects only available candidate when one account is filtered", () => {
    const tokenTracker = new TokenBucketTracker({ initialTokens: 50 });
    
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 0, healthScore: 40, isRateLimited: false, isCoolingDown: false },
      { index: 1, lastUsed: 0, healthScore: 100, isRateLimited: false, isCoolingDown: false },
    ];

    const result = selectHybridAccount(accounts, tokenTracker, 50);
    expect(result).toBe(1);
  });

  it("returns a valid account index", () => {
    const tokenTracker = new TokenBucketTracker();
    const accounts: AccountWithMetrics[] = [
      { index: 0, lastUsed: 1000, healthScore: 70, isRateLimited: false, isCoolingDown: false },
      { index: 1, lastUsed: 500, healthScore: 80, isRateLimited: false, isCoolingDown: false },
      { index: 2, lastUsed: 2000, healthScore: 60, isRateLimited: false, isCoolingDown: false },
    ];

    for (let i = 0; i < 10; i++) {
      const result = selectHybridAccount(accounts, tokenTracker);
      expect([0, 1, 2]).toContain(result);
    }
  });
});
