import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import { isString } from "@openrouter/spawn-shared";

/**
 * Tests for the cmdRun happy-path pipeline: successful download, history
 * recording, and env-var passing through execScript -> runBash.
 *
 * Existing tests cover:
 * - cmdRun error paths (invalid identifiers, unknown agents, etc.)
 * - execScript exit-code-specific error messages (exec-script-errors.test.ts)
 * - downloadScriptWithFallback failure paths (download-and-failure.test.ts)
 * - getScriptFailureGuidance in isolation (script-failure-guidance.test.ts)
 *
 * This file covers the UNTESTED integration paths:
 * - Primary URL download succeeds (no fallback needed)
 * - Primary URL fails, fallback URL succeeds
 * - saveSpawnRecord is called before script execution (history recording)
 * - History record includes agent, cloud, timestamp, and optional prompt
 * - SPAWN_PROMPT and SPAWN_MODE env vars passed to bash when prompt is set
 * - SPAWN_PROMPT and SPAWN_MODE are NOT set when no prompt is provided
 * - saveSpawnRecord failure is non-fatal (script still runs)
 * - Dry-run mode skips script download entirely
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// ── Mock clack/prompts ───────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
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
    info: mockLogInfo,
    warn: mock(() => {}),
    error: mockLogError,
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

const { cmdRun } = await import("../commands.js");

// ── Test helpers ─────────────────────────────────────────────────────────────

const VALID_SCRIPT = "#!/bin/bash\nset -eo pipefail\nexit 0";

/** Track child_process.spawn calls to verify env vars passed to bash */
let spawnCalls: Array<{
  command: string;
  args: string[];
  options: any;
}> = [];

/** Track all fetch calls to verify download behavior */
let fetchCalls: Array<{
  url: string;
}> = [];

function mockFetchForDownload(opts: {
  primaryOk?: boolean;
  fallbackOk?: boolean;
  primaryStatus?: number;
  fallbackStatus?: number;
  scriptContent?: string;
}) {
  const {
    primaryOk = true,
    fallbackOk = true,
    primaryStatus = 200,
    fallbackStatus = 200,
    scriptContent = VALID_SCRIPT,
  } = opts;

  return mock(async (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = isString(url) ? url : url instanceof URL ? url.href : url.url;
    fetchCalls.push({
      url: urlStr,
    });

    // Manifest fetch
    if (urlStr.includes("manifest.json")) {
      return new Response(JSON.stringify(mockManifest));
    }

    // Primary script URL (openrouter.ai)
    if (urlStr.includes("openrouter.ai")) {
      if (primaryOk) {
        return new Response(scriptContent, {
          status: primaryStatus,
        });
      }
      return new Response("error", {
        status: primaryStatus,
        statusText: `HTTP ${primaryStatus}`,
      });
    }

    // Fallback script URL (raw.githubusercontent.com)
    if (urlStr.includes("raw.githubusercontent.com")) {
      if (fallbackOk) {
        return new Response(scriptContent, {
          status: fallbackStatus,
        });
      }
      return new Response("error", {
        status: fallbackStatus,
        statusText: `HTTP ${fallbackStatus}`,
      });
    }

    return new Response("not found", {
      status: 404,
    });
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("cmdRun happy-path pipeline", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let historyDir: string;
  let originalSpawnHome: string | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();
    fetchCalls = [];
    spawnCalls = [];

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;

    // Set up isolated history directory
    historyDir = join(homedir(), `spawn-test-history-${Date.now()}-${Math.random()}`);
    mkdirSync(historyDir, {
      recursive: true,
    });
    originalSpawnHome = process.env.SPAWN_HOME;
    process.env.SPAWN_HOME = historyDir;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);

    // Clean up history directory
    process.env.SPAWN_HOME = originalSpawnHome;
    if (existsSync(historyDir)) {
      rmSync(historyDir, {
        recursive: true,
        force: true,
      });
    }
  });

  // ── Primary download success ──────────────────────────────────────────────

  describe("primary URL download success", () => {
    it("should download from primary URL without trying fallback", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      // Should have fetched the manifest + the primary script URL
      const scriptFetches = fetchCalls.filter((c) => !c.url.includes("manifest.json"));
      expect(scriptFetches.length).toBe(1);
      expect(scriptFetches[0].url).toContain("openrouter.ai");
    });

    it("should show spinner start and stop for successful download", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const startCalls = mockSpinnerStart.mock.calls.map((c: any[]) => c[0]);
      expect(startCalls.some((msg: string) => msg.includes("Downloading"))).toBe(true);

      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c[0]);
      expect(stopCalls.some((msg: string) => isString(msg) && msg.includes("downloaded"))).toBe(true);
    });

    it("should not call process.exit on successful execution", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Fallback download success ─────────────────────────────────────────────

  describe("fallback URL download success", () => {
    it("should fall back to GitHub when primary URL fails", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: false,
        primaryStatus: 500,
        fallbackOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      // Should have fetched manifest + primary (failed) + fallback (success)
      const scriptFetches = fetchCalls.filter((c) => !c.url.includes("manifest.json"));
      expect(scriptFetches.length).toBe(2);
      expect(scriptFetches[0].url).toContain("openrouter.ai");
      expect(scriptFetches[1].url).toContain("raw.githubusercontent.com");
    });

    it("should show fallback spinner message when primary fails", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: false,
        primaryStatus: 502,
        fallbackOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const messageCalls = mockSpinnerMessage.mock.calls.map((c: any[]) => c[0]);
      expect(messageCalls.some((msg: string) => msg.includes("fallback"))).toBe(true);
    });

    it("should show 'fallback' in stop message when fallback succeeds", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: false,
        primaryStatus: 403,
        fallbackOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const stopCalls = mockSpinnerStop.mock.calls.map((c: any[]) => c[0]);
      expect(stopCalls.some((msg: string) => isString(msg) && msg.includes("fallback"))).toBe(true);
    });
  });

  // ── History recording ─────────────────────────────────────────────────────

  describe("history recording during execution", () => {
    it("should save history record on successful execution", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const historyPath = join(historyDir, "history.json");
      expect(existsSync(historyPath)).toBe(true);
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      expect(records.length).toBeGreaterThanOrEqual(1);
      const record = records[records.length - 1];
      expect(record.agent).toBe("claude");
      expect(record.cloud).toBe("sprite");
      expect(record.timestamp).toBeDefined();
    });

    it("should include prompt in history record when provided", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", "Fix all bugs");

      const historyPath = join(historyDir, "history.json");
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      const record = records[records.length - 1];
      expect(record.prompt).toBe("Fix all bugs");
    });

    it("should not include prompt field when no prompt provided", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const historyPath = join(historyDir, "history.json");
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      const record = records[records.length - 1];
      expect(record.prompt).toBeUndefined();
    });

    it("should record timestamp in ISO 8601 format", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      const before = new Date().toISOString();
      await cmdRun("claude", "sprite");
      const after = new Date().toISOString();

      const historyPath = join(historyDir, "history.json");
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      const record = records[records.length - 1];
      expect(record.timestamp >= before).toBe(true);
      expect(record.timestamp <= after).toBe(true);
    });

    it("should record history even when script fails", async () => {
      const failScript = "#!/bin/bash\nset -eo pipefail\nexit 1";
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: failScript,
      });
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected - process.exit from reportScriptFailure
      }

      const historyPath = join(historyDir, "history.json");
      expect(existsSync(historyPath)).toBe(true);
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records[records.length - 1].agent).toBe("claude");
    });

    it("should still execute script when history save fails", async () => {
      // Make history dir read-only to force saveSpawnRecord failure
      const readOnlyDir = join(homedir(), `spawn-test-readonly-${Date.now()}`);
      mkdirSync(readOnlyDir, {
        recursive: true,
      });
      // Create a file where the directory should be, so mkdir fails
      writeFileSync(join(readOnlyDir, "history.json"), "not-a-directory");
      process.env.SPAWN_HOME = readOnlyDir;

      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      // Should complete without error even though history write might fail
      await cmdRun("claude", "sprite");
      expect(processExitSpy).not.toHaveBeenCalled();

      // Cleanup
      rmSync(readOnlyDir, {
        recursive: true,
        force: true,
      });
    });

    it("should append to existing history", async () => {
      // Pre-populate history
      const existing = [
        {
          agent: "codex",
          cloud: "hetzner",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ];
      writeFileSync(join(historyDir, "history.json"), JSON.stringify(existing));

      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const historyPath = join(historyDir, "history.json");
      const records = JSON.parse(readFileSync(historyPath, "utf-8"));
      expect(records).toHaveLength(2);
      expect(records[0].agent).toBe("codex");
      expect(records[1].agent).toBe("claude");
    });
  });

  // ── Env var passing via runBash ───────────────────────────────────────────

  describe("SPAWN_PROMPT and SPAWN_MODE env var passing", () => {
    it("should pass prompt to bash script via SPAWN_PROMPT env var", async () => {
      // Use a script that echoes the env var so we can verify it was set
      const echoScript = '#!/bin/bash\nset -eo pipefail\ntest "$SPAWN_PROMPT" = "Fix all bugs"';
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: echoScript,
      });
      await loadManifest(true);

      // If SPAWN_PROMPT is set correctly, the test command succeeds (exit 0)
      await cmdRun("claude", "sprite", "Fix all bugs");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should set SPAWN_MODE to non-interactive when prompt is provided", async () => {
      const checkScript = '#!/bin/bash\nset -eo pipefail\ntest "$SPAWN_MODE" = "non-interactive"';
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: checkScript,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", "Fix all bugs");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should NOT set SPAWN_PROMPT when no prompt is provided", async () => {
      // This script fails if SPAWN_PROMPT is set (non-empty)
      const checkScript = '#!/bin/bash\nset -eo pipefail\ntest -z "${SPAWN_PROMPT:-}"';
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: checkScript,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should NOT set SPAWN_MODE when no prompt is provided", async () => {
      const checkScript = '#!/bin/bash\nset -eo pipefail\ntest -z "${SPAWN_MODE:-}"';
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: checkScript,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("should handle prompts with special characters", async () => {
      const prompt = 'Fix the "login" page & add tests';
      const checkScript = `#!/bin/bash\nset -eo pipefail\ntest -n "$SPAWN_PROMPT"`;
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: checkScript,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", prompt);
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Dry-run mode ──────────────────────────────────────────────────────────

  describe("dry-run mode skips download", () => {
    it("should not download script in dry-run mode", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", undefined, true);

      // In dry-run, only manifest fetch should occur (no script download)
      const scriptFetches = fetchCalls.filter((c) => c.url.includes("openrouter.ai") && !c.url.includes("manifest"));
      expect(scriptFetches).toHaveLength(0);
    });

    it("should not save history in dry-run mode", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", undefined, true);

      const historyPath = join(historyDir, "history.json");
      expect(existsSync(historyPath)).toBe(false);
    });

    it("should show dry-run preview with agent and cloud info", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", undefined, true);

      const allOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(allOutput).toContain("Claude Code");
      expect(allOutput).toContain("Sprite");
    });

    it("should show prompt in dry-run preview when provided", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", "Fix bugs", true);

      const allOutput = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(allOutput).toContain("Fix bugs");
    });
  });

  // ── Launch message formatting ─────────────────────────────────────────────

  describe("launch step message", () => {
    it("should show 'Launching <agent> on <cloud>' for normal run", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toBeDefined();
      expect(launchMsg).toContain("Claude Code");
      expect(launchMsg).toContain("Sprite");
    });

    it("should append 'with prompt...' when prompt is provided", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite", "Fix bugs");

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).toContain("with prompt");
    });

    it("should append '...' without prompt when no prompt provided", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
      });
      await loadManifest(true);

      await cmdRun("claude", "sprite");

      const stepCalls = mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
      const launchMsg = stepCalls.find((msg: string) => msg.includes("Launching"));
      expect(launchMsg).not.toContain("with prompt");
    });
  });

  // ── Script content validation ─────────────────────────────────────────────

  describe("script content validation during download", () => {
    it("should reject downloaded script without shebang", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: "echo hello\nexit 0",
      });
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected - validateScriptContent rejects scripts without shebang
      }

      const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      const errOutput = [
        ...clackErrors,
        ...consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")),
      ].join("\n");
      expect(errOutput).toContain("valid bash script");
    });

    it("should reject script containing dangerous patterns", async () => {
      global.fetch = mockFetchForDownload({
        primaryOk: true,
        scriptContent: "#!/bin/bash\nrm -rf / --no-preserve-root",
      });
      await loadManifest(true);

      try {
        await cmdRun("claude", "sprite");
      } catch {
        // Expected
      }

      const clackErrors = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      const errOutput = [
        ...clackErrors,
        ...consoleMocks.error.mock.calls.map((c: any[]) => c.join(" ")),
      ].join("\n");
      expect(errOutput).toContain("dangerous");
    });
  });
});
