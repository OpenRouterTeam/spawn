import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for cmdInteractive() in commands.ts.
 *
 * cmdInteractive is the primary user entry point (invoked with bare `spawn`).
 * It has zero test coverage for:
 * - User cancels agent selection (Ctrl+C at first prompt)
 * - User cancels cloud selection (Ctrl+C at second prompt)
 * - Agent with no implemented clouds (empty cloud list)
 * - Happy path: agent selected, cloud selected, execScript called
 * - Intro banner and outro messaging
 * - "Next time, run directly" hint after selection
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Mutable state to control per-test behavior of select() and isCancel()
const CANCEL_SYMBOL = Symbol("cancel");
let selectCallIndex = 0;
let selectReturnValues: any[] = [];
let isCancelValues: Set<any> = new Set();

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockIntro = mock(() => {});
const mockOutro = mock(() => {});
const mockCancel = mock(() => {});
const mockSpinnerStart = mock(() => {});
const mockSpinnerStop = mock(() => {});
const mockSpinnerMessage = mock(() => {});

mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mockSpinnerMessage,
  }),
  log: {
    step: mockLogStep,
    info: mockLogInfo,
    error: mockLogError,
    warn: mockLogWarn,
  },
  intro: mockIntro,
  outro: mockOutro,
  cancel: mockCancel,
  select: mock(async () => {
    const value = selectReturnValues[selectCallIndex] ?? "claude";
    selectCallIndex++;
    return value;
  }),
  isCancel: (value: any) => isCancelValues.has(value),
}));

// Import commands after mock setup
const { cmdInteractive } = await import("../commands.js");

describe("cmdInteractive", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockIntro.mockClear();
    mockOutro.mockClear();
    mockCancel.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();

    // Reset per-test mutable state
    selectCallIndex = 0;
    selectReturnValues = [];
    isCancelValues = new Set();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;

    // Pre-load manifest
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => mockManifest,
      text: async () => JSON.stringify(mockManifest),
    })) as any;
    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Cancel handling ──────────────────────────────────────────────────────

  describe("cancel handling", () => {
    it("should exit with code 0 when user cancels agent selection", async () => {
      selectReturnValues = [CANCEL_SYMBOL, "sprite"];
      isCancelValues = new Set([CANCEL_SYMBOL]);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should show cancelled message when user cancels agent selection", async () => {
      selectReturnValues = [CANCEL_SYMBOL, "sprite"];
      isCancelValues = new Set([CANCEL_SYMBOL]);

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const outroOutput = mockOutro.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(outroOutput.toLowerCase()).toContain("cancelled");
    });

    it("should exit with code 0 when user cancels cloud selection", async () => {
      selectReturnValues = ["claude", CANCEL_SYMBOL];
      isCancelValues = new Set([CANCEL_SYMBOL]);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should show cancelled message when user cancels cloud selection", async () => {
      selectReturnValues = ["claude", CANCEL_SYMBOL];
      isCancelValues = new Set([CANCEL_SYMBOL]);

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const outroOutput = mockOutro.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(outroOutput.toLowerCase()).toContain("cancelled");
    });

    it("should not show launch message when user cancels", async () => {
      selectReturnValues = [CANCEL_SYMBOL, "sprite"];
      isCancelValues = new Set([CANCEL_SYMBOL]);

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeUndefined();
    });
  });

  // ── No clouds available ──────────────────────────────────────────────────

  describe("no clouds available", () => {
    it("should exit with code 1 when agent has no implemented clouds", async () => {
      // "aider" is only implemented on "sprite", but we need an agent with zero implementations.
      // Create a manifest where aider has no implemented clouds.
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/aider": "missing",
          "hetzner/aider": "missing",
        },
      };

      global.fetch = mock(async () => ({
        ok: true,
        json: async () => noCloudManifest,
        text: async () => JSON.stringify(noCloudManifest),
      })) as any;
      await loadManifest(true);

      selectReturnValues = ["aider", "sprite"];

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should show agent name in 'no clouds' error message", async () => {
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/aider": "missing",
          "hetzner/aider": "missing",
        },
      };

      global.fetch = mock(async () => ({
        ok: true,
        json: async () => noCloudManifest,
        text: async () => JSON.stringify(noCloudManifest),
      })) as any;
      await loadManifest(true);

      selectReturnValues = ["aider", "sprite"];

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Aider"))).toBe(true);
    });

    it("should suggest 'spawn list' when no clouds available", async () => {
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/aider": "missing",
          "hetzner/aider": "missing",
        },
      };

      global.fetch = mock(async () => ({
        ok: true,
        json: async () => noCloudManifest,
        text: async () => JSON.stringify(noCloudManifest),
      })) as any;
      await loadManifest(true);

      selectReturnValues = ["aider", "sprite"];

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn list"))).toBe(true);
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("should show intro banner with version", async () => {
      // Select claude + sprite, fetch returns valid script
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      expect(mockIntro).toHaveBeenCalled();
      const introArg = mockIntro.mock.calls[0]?.[0] ?? "";
      expect(introArg).toContain("spawn");
    });

    it("should show launch step with agent and cloud names", async () => {
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Claude Code");
      expect(launchMsg).toContain("Sprite");
    });

    it("should show 'run directly' hint with agent and cloud keys", async () => {
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      const hintMsg = infoCalls.find((msg: string) => msg.includes("Next time"));
      expect(hintMsg).toBeDefined();
      expect(hintMsg).toContain("spawn claude sprite");
    });

    it("should show outro message before handing off", async () => {
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      expect(mockOutro).toHaveBeenCalled();
      const outroArg = mockOutro.mock.calls[0]?.[0] ?? "";
      expect(outroArg).toContain("spawn script");
    });

    it("should work with aider agent on sprite cloud", async () => {
      selectReturnValues = ["aider", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Aider");
      expect(launchMsg).toContain("Sprite");
    });
  });

  // ── Script execution integration ─────────────────────────────────────────

  describe("script execution after selection", () => {
    it("should attempt to download script after user selects agent and cloud", async () => {
      let fetchedUrls: string[] = [];
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string") fetchedUrls.push(url);
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        return {
          ok: true,
          text: async () => "#!/bin/bash\nset -eo pipefail\nexit 0",
        };
      }) as any;
      await loadManifest(true);

      await cmdInteractive();

      // Should have fetched script URLs for sprite/claude
      const scriptUrls = fetchedUrls.filter(u => u.includes(".sh"));
      expect(scriptUrls.length).toBeGreaterThanOrEqual(1);
      expect(scriptUrls.some(u => u.includes("sprite") && u.includes("claude"))).toBe(true);
    });

    it("should propagate script download failure as process.exit(1)", async () => {
      selectReturnValues = ["claude", "sprite"];

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("manifest.json")) {
          return {
            ok: true,
            json: async () => mockManifest,
            text: async () => JSON.stringify(mockManifest),
          };
        }
        // Both primary and fallback fail
        return { ok: false, status: 404, text: async () => "Not Found" };
      }) as any;
      await loadManifest(true);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
