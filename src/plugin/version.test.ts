import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Regression tests for the version fallback mechanism.
 *
 * Issue #468: On WSL2/AlmaLinux with strict firewall rules, both the
 * auto-updater API and changelog fetch fail. The plugin then uses the
 * hardcoded fallback version in User-Agent headers. If the fallback is
 * too old, the backend rejects requests for newer models (e.g., Gemini 3.1 Pro)
 * with "not available on this version".
 *
 * These tests verify the fallback is current and that the
 * network-failure path correctly uses it.
 */

// Reset module state between tests so each starts from the fallback version
beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ANTIGRAVITY_VERSION_FALLBACK", () => {
  it("defaults to the exported fallback constant", async () => {
    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("is at least 1.18.0 to support Gemini 3.1 Pro", async () => {
    const { getAntigravityVersion } = await import("../constants.ts")
    const [major, minor] = getAntigravityVersion().split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(1)
    if (major === 1) expect(minor).toBeGreaterThanOrEqual(18)
  })

  it("is at least 2.5.2, the version gate for Gemini 3.7 Flash", async () => {
    // Verified 2026-08-17 against v1internal:fetchAvailableModels: a client
    // reporting 2.5.0 is served 24 models, 2.5.2 is served 27 including
    // gemini-3.7-flash-{low,medium,high}. Same accounts, same tokens.
    const { getAntigravityVersion } = await import("../constants.ts")
    const [major, minor, patch] = getAntigravityVersion().split(".").map(Number)
    expect(major).toBeGreaterThanOrEqual(2)
    if (major === 2) {
      expect(minor).toBeGreaterThanOrEqual(5)
      if (minor === 5) expect(patch).toBeGreaterThanOrEqual(2)
    }
  })
})

describe("setAntigravityVersion", () => {
  it("moves to a newer version, so a long-running server picks up releases", async () => {
    const { getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("90.0.0")
    expect(getAntigravityVersion()).toBe("90.0.0")
    setAntigravityVersion("91.0.0")
    expect(getAntigravityVersion()).toBe("91.0.0")
  })

  it("ignores an older version", async () => {
    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion, setAntigravityVersion } = await import("../constants.ts")
    setAntigravityVersion("1.0.0")
    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })
})

describe("initAntigravityVersion — network failure path", () => {
  it("falls back to hardcoded version when both fetches throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("falls back to hardcoded version when both fetches return non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }),
    )

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("uses API version when the auto-updater reports a newer one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "9.19.0" }),
    )

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("9.19.0")
  })

  it("never downgrades below the hardcoded floor when a source is stale", async () => {
    // The auto-updater endpoint serves a pinned "Fixed Version: 2.0.6" that
    // trails the real Antigravity releases. Taking it verbatim silently drops
    // the client below the 2.5.2 gate and hides Gemini 3.7 Flash.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "Auto updater is running. Fixed Version: 2.0.6",
      }),
    )

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("retries the changelog when the auto-updater is the stale source", async () => {
    // The auto-updater is tried first and always serves a pinned value below
    // the floor. Without this fallthrough the floor short-circuits every
    // startup, the changelog scrape never runs, and the reported version is
    // pinned to the hardcoded constant forever — dead fetch chain.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("changelog")
        ? { ok: true, text: async () => "Antigravity 9.19.0 release notes" }
        : { ok: true, text: async () => "Auto updater is running. Fixed Version: 2.0.6" },
    )
    vi.stubGlobal("fetch", fetchMock)

    const { getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe("9.19.0")
  })

  it("still floors when the changelog is also below the floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("changelog")
          ? { ok: true, text: async () => "Antigravity 2.1.0 release notes" }
          : { ok: true, text: async () => "Fixed Version: 2.0.6" },
      ),
    )

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityVersion } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    expect(getAntigravityVersion()).toBe(ANTIGRAVITY_VERSION_FALLBACK)
  })

  it("fallback version appears in User-Agent header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getAntigravityHeaders } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    const headers = getAntigravityHeaders()
    expect(headers["User-Agent"]).toContain(`Antigravity/${ANTIGRAVITY_VERSION_FALLBACK}`)
  })

  it("fallback version appears in randomized antigravity headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))

    const { ANTIGRAVITY_VERSION_FALLBACK, getRandomizedHeaders } = await import("../constants.ts")
    const { initAntigravityVersion } = await import("./version.ts")
    await initAntigravityVersion()

    const headers = getRandomizedHeaders("antigravity")
    expect(headers["User-Agent"]).toContain(ANTIGRAVITY_VERSION_FALLBACK)
  })
})
