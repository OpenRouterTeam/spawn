import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for SSH retry logic in execScript (issue #705).
 *
 * When a spawn script fails with exit code 255 (SSH connection failure),
 * the CLI retries up to 2 times with progressive delays (5s, 10s).
 * Non-retryable exit codes fail immediately.
 *
 * Agent: issue-fixer
 */

const mockManifest = createMockManifest();

// Mock @clack/prompts
const mockLogWarn = mock(() => {});
const mockLogError = mock(() => {});
const mockLogStep = mock(() => {});
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
    info: mock(() => {}),
    warn: mockLogWarn,
    error: mockLogError,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

// Import after mock setup
const { isRetryableExitCode, cmdRun } = await import("../commands.js");

// ── Unit tests for isRetryableExitCode ──────────────────────────────────────

describe("isRetryableExitCode", () => {
  it("should return true for exit code 255 (SSH failure)", () => {
    expect(isRetryableExitCode("Script exited with code 255")).toBe(true);
  });

  it("should return false for exit code 1 (too generic to retry)", () => {
    expect(isRetryableExitCode("Script exited with code 1")).toBe(false);
  });

  it("should return false for exit code 2 (syntax error)", () => {
    expect(isRetryableExitCode("Script exited with code 2")).toBe(false);
  });

  it("should return false for exit code 126 (permission denied)", () => {
    expect(isRetryableExitCode("Script exited with code 126")).toBe(false);
  });

  it("should return false for exit code 127 (command not found)", () => {
    expect(isRetryableExitCode("Script exited with code 127")).toBe(false);
  });

  it("should return false for exit code 130 (Ctrl+C)", () => {
    expect(isRetryableExitCode("Script exited with code 130")).toBe(false);
  });

  it("should return false when no exit code is found in the message", () => {
    expect(isRetryableExitCode("Some random error message")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isRetryableExitCode("")).toBe(false);
  });

  it("should return false for exit code 0", () => {
    expect(isRetryableExitCode("Script exited with code 0")).toBe(false);
  });

  it("should handle multi-digit non-retryable codes", () => {
    expect(isRetryableExitCode("Script exited with code 42")).toBe(false);
  });
});

// ── Integration tests for retry behavior in execScript ──────────────────────

describe("execScript retry logic", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogWarn.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;

    // Mock setTimeout to resolve immediately (avoid real delays in tests)
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => {
      fn();
      return 0;
    }) as any;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  function mockFetchWithScript(scriptBody: string) {
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
        text: async () => `#!/bin/bash\nset -eo pipefail\n${scriptBody}`,
      };
    }) as any;
  }

  function getWarnOutput(): string {
    return mockLogWarn.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function getErrorOutput(): string {
    const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
    const consoleErrors = consoleMocks.error.mock.calls.map((c: any[]) => c.join(" "));
    return [...clackErrors, ...consoleErrors].join("\n");
  }

  it("should not retry for exit code 2 (syntax error)", async () => {
    mockFetchWithScript("exit 2");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - process.exit
    }

    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
  });

  it("should not retry for exit code 126 (permission denied)", async () => {
    mockFetchWithScript("exit 126");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
  });

  it("should not retry for exit code 127 (command not found)", async () => {
    mockFetchWithScript("exit 127");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
  });

  it("should still show retry suggestion for non-retryable failures", async () => {
    mockFetchWithScript("exit 126");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const errors = getErrorOutput();
    expect(errors).toContain("spawn claude sprite");
  });

  it("should show warning messages when retrying exit code 255", async () => {
    // Use exit 255 which is retryable - the script will fail all 3 attempts
    mockFetchWithScript("exit 255");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - process.exit after exhausting retries
    }

    const warnings = getWarnOutput();
    expect(warnings).toContain("Retrying");
    expect(warnings).toContain("attempt 2/3");
  });

  it("should not retry for exit code 1 (too generic)", async () => {
    mockFetchWithScript("exit 1");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
  });

  it("should eventually report failure after exhausting retries", async () => {
    mockFetchWithScript("exit 255");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected
    }

    const errors = getErrorOutput();
    expect(errors).toContain("Spawn script failed");
  });

  it("should succeed without retry for exit code 0", async () => {
    mockFetchWithScript("exit 0");
    await loadManifest(true);

    await cmdRun("claude", "sprite");

    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it("should handle Ctrl+C (exit 130) without retry", async () => {
    mockFetchWithScript("exit 130");
    await loadManifest(true);

    try {
      await cmdRun("claude", "sprite");
    } catch {
      // Expected - process.exit
    }

    expect(processExitSpy).toHaveBeenCalledWith(130);
    const warnings = getWarnOutput();
    expect(warnings).not.toContain("Retrying");
  });
});
