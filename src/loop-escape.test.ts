import { beforeEach, describe, expect, it } from "vitest";

// Mirror plugin.test.ts: the plugin module imports `tool` from the SDK. It is
// only invoked inside createAntigravityPlugin (not at module load), but we mock
// it defensively so importing the module never touches the real SDK surface.
const { loopEscapeTestHooks } = await import("./plugin");
const { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_ENDPOINT_PROD } = await import("./constants");

const hooks = loopEscapeTestHooks;
type ManagedAccount = import("./plugin/accounts").ManagedAccount;

beforeEach(() => {
  hooks.resetAllInternalState();
});

describe("fix 1: capacity-retry loop escape decision (hasUsableEndpointAfterIndex)", () => {
  // ANTIGRAVITY_ENDPOINT_FALLBACKS = [DAILY, AUTOPUSH, PROD]; PROD is the last entry.
  const prodIndex = ANTIGRAVITY_ENDPOINT_FALLBACKS.indexOf(ANTIGRAVITY_ENDPOINT_PROD);

  it("PROD is the only usable endpoint for gemini-cli (sandbox endpoints skipped)", () => {
    for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
      const endpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i]!;
      const usable = hooks.isEndpointUsableForHeaderStyle(endpoint, "gemini-cli");
      expect(usable).toBe(endpoint === ANTIGRAVITY_ENDPOINT_PROD);
    }
  });

  it("all endpoints are usable for the antigravity header style", () => {
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
      expect(hooks.isEndpointUsableForHeaderStyle(endpoint, "antigravity")).toBe(true);
    }
  });

  it("gemini-cli has NO usable endpoint after PROD -> must switch account after capacity exhaustion", () => {
    // This is the crux of the loop-escape fix: for gemini-cli the PROD endpoint
    // is the last (and only) usable one, so once capacity retries are exhausted
    // there is nothing else to try and control must return to account rotation.
    expect(hooks.hasUsableEndpointAfterIndex(prodIndex, "gemini-cli")).toBe(false);
    // Earlier indices also have no *usable* endpoint after them for gemini-cli
    // because the intermediate sandbox endpoints are skipped.
    expect(hooks.hasUsableEndpointAfterIndex(0, "gemini-cli")).toBe(true); // PROD still ahead
    expect(hooks.hasUsableEndpointAfterIndex(prodIndex - 1, "gemini-cli")).toBe(true);
  });

  it("antigravity still tries later endpoints, but switches after the last one", () => {
    for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1; i++) {
      expect(hooks.hasUsableEndpointAfterIndex(i, "antigravity")).toBe(true);
    }
    // After the final endpoint there is nothing left -> switch account.
    expect(
      hooks.hasUsableEndpointAfterIndex(ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1, "antigravity"),
    ).toBe(false);
  });
});

describe("fix 1 (review): capacity fallback prefers the alternate quota pool on the same account", () => {
  // The terminal capacity-escape marks the current pool rate-limited BEFORE asking
  // for the available header style, so getAvailableHeaderStyle returns the ALTERNATE
  // pool and resolveQuotaFallbackHeaderStyle yields it — letting the request retry
  // gemini-cli on the SAME account before the whole account is excluded.
  it("resolveQuotaFallbackHeaderStyle returns the alternate style, and null once both are locked", () => {
    // antigravity exhausted, gemini-cli still available -> fall back to gemini-cli
    expect(
      hooks.resolveQuotaFallbackHeaderStyle({
        family: "gemini",
        headerStyle: "antigravity",
        alternateStyle: "gemini-cli",
      }),
    ).toBe("gemini-cli");
    // Both pools locked (getAvailableHeaderStyle would return null) -> no fallback,
    // escape to account rotation.
    expect(
      hooks.resolveQuotaFallbackHeaderStyle({
        family: "gemini",
        headerStyle: "antigravity",
        alternateStyle: null,
      }),
    ).toBe(null);
    // Alternate equals current (e.g. current pool not yet marked) -> no fallback.
    expect(
      hooks.resolveQuotaFallbackHeaderStyle({
        family: "gemini",
        headerStyle: "antigravity",
        alternateStyle: "antigravity",
      }),
    ).toBe(null);
    // Claude has no alternate quota pool.
    expect(
      hooks.resolveQuotaFallbackHeaderStyle({
        family: "claude",
        headerStyle: "antigravity",
        alternateStyle: "gemini-cli",
      }),
    ).toBe(null);
  });
});

describe("per-account request state follows the account, not its position", () => {
  // Every route in the process shares the pool (account-pool.ts), and accounts
  // can be appended or disabled while requests run, so state is keyed by the
  // account object. Two accounts with the same index never share state.
  const first = { index: 0, email: "a@example.com" } as ManagedAccount;
  const second = { index: 0, email: "b@example.com" } as ManagedAccount;

  it("keeps rate-limit backoff per account and quota key", () => {
    expect(hooks.getRateLimitBackoff(first, "claude", null).attempt).toBe(1);
    expect(hooks.getRateLimitConsecutive(first, "claude")).toBe(1);
    expect(hooks.getRateLimitConsecutive(first, "gemini-cli")).toBe(undefined);
    expect(hooks.getRateLimitConsecutive(second, "claude")).toBe(undefined);
  });

  it("keeps failure counts per account", () => {
    hooks.trackAccountFailure(first);
    hooks.trackAccountFailure(first);
    hooks.seedAccountFailure(second, 4);
    expect(hooks.getAccountFailureCount(first)).toBe(2);
    expect(hooks.getAccountFailureCount(second)).toBe(4);
    expect(hooks.trackAccountFailure(second).shouldCooldown).toBe(true);
  });
});
