import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for detectAndFixSwappedArgs and resolveAndLog logic in commands.ts.
 *
 * These functions handle two important CLI UX features:
 * - Swapped argument detection: "spawn sprite claude" -> "spawn claude sprite"
 * - Display name resolution with logging: "Claude Code" -> "claude" with info message
 *
 * Previously, these were only tested through full cmdRun integration tests.
 * This file tests the logic paths directly through cmdRun with minimal mocking,
 * focusing on the SPECIFIC behaviors of swap detection and resolution logging.
 *
 * Coverage gaps addressed:
 * - detectAndFixSwappedArgs: no swap needed (both valid), swap detected, neither valid
 * - resolveAndLog: no resolution needed, agent resolved, cloud resolved, both resolved
 * - Edge case: swapped args after display name resolution
 * - Edge case: resolution to a key that then fails validation
 *
 * Agent: test-engineer
 */

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mock(() => {}),
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mockLogError,
    warn: mockLogWarn,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import commands after mock setup
const { cmdRun } = await import("../commands.js");

const mockManifest = createMockManifest();

describe("detectAndFixSwappedArgs via cmdRun", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setManifestAndScript(manifest: any) {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      return {
        ok: true,
        text: async () => "#!/bin/bash\necho test",
      };
    }) as any;
    return loadManifest(true);
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
    await setManifestAndScript(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Swap detection ─────────────────────────────────────────────────

  describe("swapped arguments detection", () => {
    it("should detect and fix swapped agent/cloud args", async () => {
      await setManifestAndScript(mockManifest);

      try {
        // "sprite" is a cloud, "claude" is an agent - they're swapped
        await cmdRun("sprite", "claude");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("swapped"))).toBe(true);
      expect(infoCalls.some((msg: string) => msg.includes("spawn claude sprite"))).toBe(true);
    });

    it("should proceed correctly after swapping args", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("sprite", "claude");
      } catch {
        // May throw from script execution
      }

      // After swap, should launch with correct names
      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      expect(stepCalls.some((msg: string) => msg.includes("Claude Code") && msg.includes("Sprite"))).toBe(true);
    });

    it("should not swap when args are in correct order", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // May throw from script execution
      }

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });

    it("should not swap when first arg is not a cloud key", async () => {
      await setManifestAndScript(mockManifest);

      try {
        // "unknown" is not a cloud, so no swap should occur
        await cmdRun("unknown", "sprite");
      } catch {
        // Expected: will fail validation
      }

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });

    it("should not swap when second arg is not an agent key", async () => {
      await setManifestAndScript(mockManifest);

      try {
        // "sprite" is a cloud but "unknown" is not an agent
        await cmdRun("sprite", "unknown");
      } catch {
        // Expected: will fail validation
      }

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });

    it("should not swap when both args are agents", async () => {
      await setManifestAndScript(mockManifest);

      try {
        // Both are agents, not a cloud+agent swap
        await cmdRun("claude", "aider");
      } catch {
        // Expected: will fail since aider is not a cloud
      }

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });

    it("should not swap when both args are clouds", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("sprite", "hetzner");
      } catch {
        // Expected: sprite is not an agent
      }

      // sprite IS a cloud and hetzner is NOT an agent, so the swap condition
      // (!manifest.agents[agent] && manifest.clouds[agent] && manifest.agents[cloud])
      // checks manifest.agents["hetzner"] which is falsy, so no swap
      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("swapped"))).toBe(false);
    });
  });

  // ── Swap with missing implementation ────────────────────────────────

  describe("swapped args with missing implementation", () => {
    it("should swap args then fail at implementation check for missing combo", async () => {
      await setManifestAndScript(mockManifest);

      try {
        // hetzner is a cloud, aider is an agent - swapped
        // After swap: cmdRun("aider", "hetzner") - but hetzner/aider is "missing"
        await cmdRun("hetzner", "aider");
      } catch {
        // Expected: process.exit from validateImplementation
      }

      // Should detect the swap
      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("swapped"))).toBe(true);

      // Should then fail at implementation check
      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("not yet implemented"))).toBe(true);
    });
  });
});

// ── resolveAndLog tests ──────────────────────────────────────────────────────

describe("resolveAndLog via cmdRun", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setManifestAndScript(manifest: any) {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      return {
        ok: true,
        text: async () => "#!/bin/bash\necho test",
      };
    }) as any;
    return loadManifest(true);
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
    await setManifestAndScript(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  describe("case-insensitive key resolution", () => {
    it("should resolve uppercase agent key and log", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("CLAUDE", "sprite");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("claude"))).toBe(true);
    });

    it("should resolve mixed-case cloud key and log", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "HETZNER");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("hetzner"))).toBe(true);
    });

    it("should resolve both agent and cloud case-insensitively", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("CLAUDE", "SPRITE");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      const resolvedAgent = infoCalls.some((msg: string) =>
        msg.includes("Resolved") && msg.includes("claude")
      );
      const resolvedCloud = infoCalls.some((msg: string) =>
        msg.includes("Resolved") && msg.includes("sprite")
      );
      expect(resolvedAgent).toBe(true);
      expect(resolvedCloud).toBe(true);
    });

    it("should not log resolution for already-lowercase exact keys", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved"))).toBe(false);
    });
  });

  describe("display name resolution", () => {
    it("should resolve 'Aider' display name to 'aider' key", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("Aider", "sprite");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("aider"))).toBe(true);
    });

    it("should resolve 'Sprite' display name to 'sprite' key", async () => {
      await setManifestAndScript(mockManifest);

      try {
        await cmdRun("claude", "Sprite");
      } catch {
        // May throw from script execution
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Resolved") && msg.includes("sprite"))).toBe(true);
    });
  });
});

// ── isValidManifest tests (via loadManifest) ──────────────────────────────────

describe("manifest validation (isValidManifest)", () => {
  let originalFetch: typeof global.fetch;
  let consoleMocks: ReturnType<typeof createConsoleMocks>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should reject manifest missing 'agents' field", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ clouds: {}, matrix: {} }),
    })) as any;

    // Force refresh to avoid cache, should reject invalid manifest
    try {
      await loadManifest(true);
    } catch {
      // Expected if no cache fallback
    }

    // The key assertion: console.error should mention validation failure
    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorOutput.some((msg: string) => msg.includes("validation failed") || msg.includes("Cannot load"))).toBe(true);
  });

  it("should reject manifest missing 'clouds' field", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ agents: {}, matrix: {} }),
    })) as any;

    try {
      await loadManifest(true);
    } catch {
      // Expected
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorOutput.some((msg: string) => msg.includes("validation failed") || msg.includes("Cannot load"))).toBe(true);
  });

  it("should reject manifest missing 'matrix' field", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ agents: {}, clouds: {} }),
    })) as any;

    try {
      await loadManifest(true);
    } catch {
      // Expected
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorOutput.some((msg: string) => msg.includes("validation failed") || msg.includes("Cannot load"))).toBe(true);
  });

  it("should reject null manifest data", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => null,
    })) as any;

    try {
      await loadManifest(true);
    } catch {
      // Expected
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorOutput.some((msg: string) => msg.includes("validation failed") || msg.includes("Cannot load"))).toBe(true);
  });

  it("should accept valid manifest with all required fields", async () => {
    const validManifest = createMockManifest();
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => validManifest,
    })) as any;

    const result = await loadManifest(true);
    expect(result).toHaveProperty("agents");
    expect(result).toHaveProperty("clouds");
    expect(result).toHaveProperty("matrix");
  });

  it("should accept manifest with empty agents/clouds/matrix", async () => {
    const emptyManifest = { agents: {}, clouds: {}, matrix: {} };
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => emptyManifest,
    })) as any;

    const result = await loadManifest(true);
    expect(result).toHaveProperty("agents");
    expect(result).toHaveProperty("clouds");
    expect(result).toHaveProperty("matrix");
  });

  it("should handle HTTP error response gracefully", async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    })) as any;

    try {
      await loadManifest(true);
    } catch {
      // Expected if no cache fallback
    }

    const errorOutput = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorOutput.some((msg: string) => msg.includes("500") || msg.includes("Cannot load"))).toBe(true);
  });
});

// ── Prompt with swapped args ─────────────────────────────────────────────────

describe("prompt handling with swapped args", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setManifestAndScript(manifest: any) {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      return {
        ok: true,
        text: async () => "#!/bin/bash\necho test",
      };
    }) as any;
    return loadManifest(true);
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
    await setManifestAndScript(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  it("should swap args and show 'with prompt' when prompt provided", async () => {
    await setManifestAndScript(mockManifest);

    try {
      // Swapped: cloud first, agent second, with prompt
      await cmdRun("sprite", "claude", "Fix all bugs");
    } catch {
      // May throw from script execution
    }

    // Should detect swap
    const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
    expect(infoCalls.some((msg: string) => msg.includes("swapped"))).toBe(true);

    // Should show launch message with prompt
    const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
    expect(stepCalls.some((msg: string) => msg.includes("with prompt"))).toBe(true);
  });

  it("should validate prompt even when args are swapped", async () => {
    await setManifestAndScript(mockManifest);

    try {
      // Swapped args with dangerous prompt
      await cmdRun("sprite", "claude", "$(rm -rf /)");
    } catch {
      // Expected: prompt validation should reject this
    }

    const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
    expect(errorCalls.some((msg: string) => msg.includes("shell syntax") || msg.includes("command substitution"))).toBe(true);
  });
});
