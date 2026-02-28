import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import { isString } from "@openrouter/spawn-shared";

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
const mockConfirm = mock(async () => true);
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
  confirm: mockConfirm,
  text: mock(async () => undefined),
  autocomplete: mock(async () => {
    const value = selectReturnValues[selectCallIndex] ?? "claude";
    selectCallIndex++;
    return value;
  }),
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
    mockConfirm.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();

    // Reset per-test mutable state
    selectCallIndex = 0;
    selectReturnValues = [];
    isCancelValues = new Set();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;

    // Pre-load manifest
    global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
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
      selectReturnValues = [
        CANCEL_SYMBOL,
        "sprite",
      ];
      isCancelValues = new Set([
        CANCEL_SYMBOL,
      ]);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should show cancelled message when user cancels agent selection", async () => {
      selectReturnValues = [
        CANCEL_SYMBOL,
        "sprite",
      ];
      isCancelValues = new Set([
        CANCEL_SYMBOL,
      ]);

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const outroOutput = mockOutro.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(outroOutput.toLowerCase()).toContain("cancelled");
    });

    it("should exit with code 0 when user cancels cloud selection", async () => {
      selectReturnValues = [
        "claude",
        CANCEL_SYMBOL,
      ];
      isCancelValues = new Set([
        CANCEL_SYMBOL,
      ]);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should show cancelled message when user cancels cloud selection", async () => {
      selectReturnValues = [
        "claude",
        CANCEL_SYMBOL,
      ];
      isCancelValues = new Set([
        CANCEL_SYMBOL,
      ]);

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const outroOutput = mockOutro.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(outroOutput.toLowerCase()).toContain("cancelled");
    });

    it("should not show launch message when user cancels", async () => {
      selectReturnValues = [
        CANCEL_SYMBOL,
        "sprite",
      ];
      isCancelValues = new Set([
        CANCEL_SYMBOL,
      ]);

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
      // "codex" is only implemented on "sprite", but we need an agent with zero implementations.
      // Create a manifest where codex has no implemented clouds.
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/codex": "missing",
          "hetzner/codex": "missing",
        },
      };

      global.fetch = mock(async () => new Response(JSON.stringify(noCloudManifest)));
      await loadManifest(true);

      selectReturnValues = [
        "codex",
        "sprite",
      ];

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should show agent name in 'no clouds' error message", async () => {
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/codex": "missing",
          "hetzner/codex": "missing",
        },
      };

      global.fetch = mock(async () => new Response(JSON.stringify(noCloudManifest)));
      await loadManifest(true);

      selectReturnValues = [
        "codex",
        "sprite",
      ];

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Codex"))).toBe(true);
    });

    it("should suggest 'spawn matrix' when no clouds available", async () => {
      const noCloudManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
          "sprite/codex": "missing",
          "hetzner/codex": "missing",
        },
      };

      global.fetch = mock(async () => new Response(JSON.stringify(noCloudManifest)));
      await loadManifest(true);

      selectReturnValues = [
        "codex",
        "sprite",
      ];

      try {
        await cmdInteractive();
      } catch {
        // Expected
      }

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn matrix"))).toBe(true);
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("should show intro banner with version", async () => {
      // Select claude + sprite, fetch returns valid script
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      expect(mockIntro).toHaveBeenCalled();
      const introArg = mockIntro.mock.calls[0]?.[0] ?? "";
      expect(introArg).toContain("spawn");
    });

    it("should show launch step with agent and cloud names", async () => {
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Claude Code");
      expect(launchMsg).toContain("Sprite");
    });

    it("should show 'run directly' hint with agent and cloud keys", async () => {
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      const hintMsg = infoCalls.find((msg: string) => msg.includes("Next time"));
      expect(hintMsg).toBeDefined();
      expect(hintMsg).toContain("spawn claude sprite");
    });

    it("should show outro message before handing off", async () => {
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      expect(mockOutro).toHaveBeenCalled();
      const outroArg = mockOutro.mock.calls[0]?.[0] ?? "";
      expect(outroArg).toContain("spawn script");
    });

    it("should work with codex agent on sprite cloud", async () => {
      selectReturnValues = [
        "codex",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Codex");
      expect(launchMsg).toContain("Sprite");
    });
  });

  // ── Script execution integration ─────────────────────────────────────────

  describe("script execution after selection", () => {
    it("should attempt to download script after user selects agent and cloud", async () => {
      const fetchedUrls: string[] = [];
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url)) {
          fetchedUrls.push(url);
        }
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      // Should have fetched script URLs for sprite/claude
      const scriptUrls = fetchedUrls.filter((u) => u.includes(".sh"));
      expect(scriptUrls.length).toBeGreaterThanOrEqual(1);
      expect(scriptUrls.some((u) => u.includes("sprite") && u.includes("claude"))).toBe(true);
    });

    it("should propagate script download failure as process.exit(1)", async () => {
      selectReturnValues = [
        "claude",
        "sprite",
      ];

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(mockManifest));
        }
        // Both primary and fallback fail
        return new Response("Not Found", {
          status: 404,
        });
      });
      await loadManifest(true);

      await expect(cmdInteractive()).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Preflight credential check ──────────────────────────────────────────

  describe("preflight credential check", () => {
    it("should warn about missing credentials before launching", async () => {
      // Use a manifest with a real-looking auth var that won't be set
      const credManifest = {
        ...mockManifest,
        clouds: {
          ...mockManifest.clouds,
          sprite: {
            ...mockManifest.clouds.sprite,
            auth: "SPRITE_API_KEY",
          },
        },
      };

      selectReturnValues = [
        "claude",
        "sprite",
      ];
      delete process.env.SPRITE_API_KEY;

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(credManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      expect(warnCalls.some((msg: string) => msg.includes("SPRITE_API_KEY"))).toBe(true);
    });

    it("should not warn when all credentials are set", async () => {
      // Use a manifest with auth var that IS set
      const credManifest = {
        ...mockManifest,
        clouds: {
          ...mockManifest.clouds,
          sprite: {
            ...mockManifest.clouds.sprite,
            auth: "SPRITE_API_KEY",
          },
        },
      };

      selectReturnValues = [
        "claude",
        "sprite",
      ];
      const savedKey = process.env.SPRITE_API_KEY;
      const savedOR = process.env.OPENROUTER_API_KEY;
      process.env.SPRITE_API_KEY = "test-sprite-key";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      global.fetch = mock(async (url: string) => {
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(credManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      const warnCalls = mockLogWarn.mock.calls.map((c: any[]) => c.join(" "));
      const credWarn = warnCalls.find((msg: string) => msg.includes("Missing credentials"));
      expect(credWarn).toBeUndefined();

      // Restore env
      if (savedKey === undefined) {
        delete process.env.SPRITE_API_KEY;
      } else {
        process.env.SPRITE_API_KEY = savedKey;
      }
      if (savedOR === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = savedOR;
      }
    });

    it("should still launch script after credential warning", async () => {
      const credManifest = {
        ...mockManifest,
        clouds: {
          ...mockManifest.clouds,
          sprite: {
            ...mockManifest.clouds.sprite,
            auth: "SPRITE_API_KEY",
          },
        },
      };

      selectReturnValues = [
        "claude",
        "sprite",
      ];
      delete process.env.SPRITE_API_KEY;

      const fetchedUrls: string[] = [];
      global.fetch = mock(async (url: string) => {
        if (isString(url)) {
          fetchedUrls.push(url);
        }
        if (isString(url) && url.includes("manifest.json")) {
          return new Response(JSON.stringify(credManifest));
        }
        return new Response("#!/bin/bash\nset -eo pipefail\nexit 0");
      });
      await loadManifest(true);

      await cmdInteractive();

      // Script should still be downloaded despite credential warning
      const scriptUrls = fetchedUrls.filter((u) => u.includes(".sh"));
      expect(scriptUrls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
