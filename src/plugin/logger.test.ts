import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "./logger"

describe("logger console sink", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("writes to the console when OPENCODE_ANTIGRAVITY_CONSOLE_LOG is set", () => {
    vi.stubEnv("OPENCODE_ANTIGRAVITY_CONSOLE_LOG", "1")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})

    createLogger("request").info("thinking-resolution", { status: 429 })

    expect(info).toHaveBeenCalledWith("[antigravity.request]", "thinking-resolution", { status: 429 })
  })

  it("discards logs when console logging is off", () => {
    vi.stubEnv("OPENCODE_ANTIGRAVITY_CONSOLE_LOG", "")
    const info = vi.spyOn(console, "info").mockImplementation(() => {})

    createLogger("request").info("dropped")

    expect(info).not.toHaveBeenCalled()
  })
})
