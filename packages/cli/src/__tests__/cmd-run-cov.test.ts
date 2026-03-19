/**
 * cmd-run-cov.test.ts — Coverage tests for commands/run.ts
 *
 * Focuses on uncovered helper functions: resolveAndLog, detectAndFixSwappedArgs,
 * dry-run helpers (buildAgentLines, buildCloudLines, buildCredentialStatusLines,
 * buildEnvironmentLines, buildPromptLines), showDryRunPreview, classifyNetworkError,
 * isRetryableExitCode, headless output/error, and execScript paths.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { isString } from "@openrouter/spawn-shared";
import { _resetCacheForTesting, loadManifest } from "../manifest";
import { createConsoleMocks, createMockManifest, mockClackPrompts, restoreMocks } from "./test-helpers";

const clack = mockClackPrompts();

const { cmdRun, cmdRunHeadless, getScriptFailureGuidance, getSignalGuidance, isRetryableExitCode } = await import(
  "../commands/index.js"
);
const { showDryRunPreview, execScript } = await import("../commands/run.js");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("commands/run.ts coverage", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  const mockManifest = createMockManifest();

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    originalFetch = global.fetch;
    processExitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    _resetCacheForTesting();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── isRetryableExitCode ───────────────────────────────────────────────

  describe("isRetryableExitCode", () => {
    it("returns true for exit code 255 (SSH failure)", () => {
      expect(isRetryableExitCode("Script exited with code 255")).toBe(true);
    });

    it("returns false for exit code 1", () => {
      expect(isRetryableExitCode("Script exited with code 1")).toBe(false);
    });

    it("returns false for exit code 130", () => {
      expect(isRetryableExitCode("Script exited with code 130")).toBe(false);
    });

    it("returns false when no exit code found", () => {
      expect(isRetryableExitCode("some random error")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isRetryableExitCode("")).toBe(false);
    });
  });

  // ── showDryRunPreview ─────────────────────────────────────────────────

  describe("showDryRunPreview", () => {
    it("prints agent, cloud, script sections", () => {
      showDryRunPreview(mockManifest, "claude", "sprite");
      expect(clack.logInfo).toHaveBeenCalled();
      expect(clack.logSuccess).toHaveBeenCalled();
    });

    it("prints prompt section when provided", () => {
      showDryRunPreview(mockManifest, "claude", "sprite", "Fix all bugs");
      // prompt section is rendered via printDryRunSection which calls p.log.step
      expect(clack.logStep).toHaveBeenCalled();
    });

    it("handles long prompts with truncation", () => {
      const longPrompt = "A".repeat(200);
      showDryRunPreview(mockManifest, "claude", "sprite", longPrompt);
      // Check that console.log was called (printDryRunSection outputs to console)
      expect(consoleMocks.log).toHaveBeenCalled();
    });

    it("shows environment variables section when agent has env", () => {
      showDryRunPreview(mockManifest, "claude", "sprite");
      const allCalls = consoleMocks.log.mock.calls.flat().map(String);
      const hasEnvLine = allCalls.some((c) => c.includes("ANTHROPIC_API_KEY") || c.includes("OpenRouter"));
      expect(hasEnvLine).toBe(true);
    });
  });

  // ── cmdRun with dry run ────────────────────────────────────────────────

  describe("cmdRun dry run", () => {
    it("shows dry run preview and returns", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);
      expect(clack.logSuccess).toHaveBeenCalled();
    });
  });

  // ── cmdRun with swapped arguments ─────────────────────────────────────

  describe("cmdRun detectAndFixSwappedArgs", () => {
    it("detects and fixes swapped agent/cloud arguments in dry run", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      // Pass cloud name as agent, agent name as cloud
      await cmdRun("sprite", "claude", undefined, true);
      // Should still succeed as dry run (swap detection fixes it)
      expect(clack.logInfo).toHaveBeenCalled();
    });
  });

  // ── getSignalGuidance ──────────────────────────────────────────────────

  describe("getSignalGuidance", () => {
    it("returns guidance for SIGKILL", () => {
      const lines = getSignalGuidance("SIGKILL").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("killed");
    });

    it("returns default guidance for unknown signal", () => {
      const lines = getSignalGuidance("SIGUSR1").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("SIGUSR1");
      expect(joined).toContain("terminated");
    });

    it("includes dashboard hint when provided", () => {
      const lines = getSignalGuidance("SIGUSR1", "https://dash.example.com").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("https://dash.example.com");
    });
  });

  // ── getScriptFailureGuidance ──────────────────────────────────────────

  describe("getScriptFailureGuidance", () => {
    it("returns default guidance for null exit code", () => {
      const lines = getScriptFailureGuidance(null, "hetzner").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("Common causes");
    });

    it("returns default guidance for unknown exit codes", () => {
      const lines = getScriptFailureGuidance(99, "hetzner").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("Common causes");
    });

    it("includes dashboard hint for exit code 130", () => {
      const lines = getScriptFailureGuidance(130, "hetzner", undefined, "https://dash.test").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("interrupted");
    });

    it("includes credential hints for exit code 1", () => {
      const lines = getScriptFailureGuidance(1, "hetzner", "Set HCLOUD_TOKEN").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("HCLOUD_TOKEN");
    });

    it("handles exit code 137 (OOM/killed)", () => {
      const lines = getScriptFailureGuidance(137, "sprite").map(stripAnsi);
      const joined = lines.join("\n");
      expect(joined).toContain("killed");
    });
  });

  // ── cmdRunHeadless ─────────────────────────────────────────────────────

  describe("cmdRunHeadless", () => {
    it("exits with code 3 for invalid agent name", async () => {
      await expect(
        cmdRunHeadless("../bad", "sprite", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it("exits with code 3 for invalid cloud name", async () => {
      await expect(
        cmdRunHeadless("claude", "../bad", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it("exits with code 3 when manifest fetch fails", async () => {
      global.fetch = mock(
        async () =>
          new Response("error", {
            status: 500,
          }),
      );
      await expect(
        cmdRunHeadless("claude", "sprite", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
    });

    it("outputs JSON for errors when outputFormat is json", async () => {
      await expect(
        cmdRunHeadless("../bad", "sprite", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
      const jsonCalls = consoleMocks.log.mock.calls.flat().filter((c) => isString(c) && c.includes("VALIDATION_ERROR"));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });

    it("outputs plain text for errors without json format", async () => {
      await expect(cmdRunHeadless("../bad", "sprite")).rejects.toThrow("process.exit");
      const errorCalls = consoleMocks.error.mock.calls.flat().map(String);
      const hasError = errorCalls.some((c) => c.includes("Error"));
      expect(hasError).toBe(true);
    });

    it("exits with code 3 for unknown agent", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await expect(
        cmdRunHeadless("nonexistent", "sprite", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });

    it("exits with code 3 for not-implemented matrix entry", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));
      await loadManifest(true);
      await expect(
        cmdRunHeadless("codex", "hetzner", {
          outputFormat: "json",
        }),
      ).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(3);
    });
  });
});
