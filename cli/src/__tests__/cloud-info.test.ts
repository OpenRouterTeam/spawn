import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";

/**
 * Tests for cmdCloudInfo in commands.ts.
 *
 * cmdCloudInfo is the only major command function with zero test coverage.
 * It handles "spawn <cloud>" to show available agents for a cloud provider.
 *
 * Covers:
 * - Happy path: display cloud name, description, available agents
 * - Cloud with notes field
 * - Cloud with no implemented agents
 * - Error paths: invalid identifier, unknown cloud, empty/whitespace name
 * - Typo suggestion for unknown cloud names
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Extended manifest with a cloud that has notes and a cloud with no agents
const extendedManifest: Manifest = {
  agents: mockManifest.agents,
  clouds: {
    ...mockManifest.clouds,
    railway: {
      name: "Railway",
      description: "Container platform",
      url: "https://railway.app",
      type: "container",
      auth: "token",
      provision_method: "cli",
      exec_method: "exec",
      interactive_method: "exec",
      notes: "Requires Railway CLI installed locally",
    },
    emptycloud: {
      name: "Empty Cloud",
      description: "No agents here",
      url: "https://empty.example.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    local: {
      name: "Local Machine",
      description: "Run agents locally",
      url: "https://github.com/OpenRouterTeam/spawn",
      type: "local",
      auth: "none",
      provision_method: "none",
      exec_method: "bash -c",
      interactive_method: "bash -c",
    },
    authcloud: {
      name: "Auth Cloud",
      description: "Cloud with env var auth",
      url: "https://auth.example.com",
      type: "cloud",
      auth: "AUTH_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    ...mockManifest.matrix,
    "railway/claude": "implemented",
    "railway/codex": "missing",
    "local/claude": "implemented",
    "local/codex": "implemented",
    "authcloud/claude": "implemented",
    // emptycloud has no matrix entries at all
  },
};

// Mock @clack/prompts
const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
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
    warn: mock(() => {}),
    error: mockLogError,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

// Import commands after mock setup
const { cmdCloudInfo } = await import("../commands.js");

describe("cmdCloudInfo", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedORKey: string | undefined;

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    savedORKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    originalFetch = global.fetch;
    global.fetch = mock(async () => new Response(JSON.stringify(extendedManifest)));

    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (savedORKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedORKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  describe("display output for valid cloud", () => {
    it("should show cloud name and description for sprite", async () => {
      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Sprite");
      expect(output).toContain("Lightweight VMs");
    });

    it("should show Available agents header", async () => {
      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Available agents");
    });

    it("should list implemented agents for sprite", async () => {
      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("claude");
      expect(output).toContain("codex");
    });

    it("should show launch command hint for each agent", async () => {
      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn claude sprite");
      expect(output).toContain("spawn codex sprite");
    });

    it("should only show implemented agents for hetzner", async () => {
      await cmdCloudInfo("hetzner");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("claude");
      // hetzner/codex is "missing" in mock manifest
      expect(output).not.toContain("spawn codex hetzner");
    });

    it("should show hetzner name and description", async () => {
      await cmdCloudInfo("hetzner");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("European cloud provider");
    });

    it("should use spinner while loading manifest", async () => {
      await cmdCloudInfo("sprite");
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });

  // ── Cloud with notes field ──────────────────────────────────────────────

  describe("cloud with notes", () => {
    it("should display notes when the cloud has them", async () => {
      await cmdCloudInfo("railway");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Requires Railway CLI installed locally");
    });

    it("should show railway name and description", async () => {
      await cmdCloudInfo("railway");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Railway");
      expect(output).toContain("Container platform");
    });

    it("should show only implemented agents for railway", async () => {
      await cmdCloudInfo("railway");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("spawn claude railway");
      expect(output).not.toContain("spawn codex railway");
    });
  });

  // ── Cloud with no implemented agents ───────────────────────────────────

  describe("cloud with no implemented agents", () => {
    it("should show 'No implemented agents' message", async () => {
      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("No implemented agents");
    });

    it("should still show cloud name and description", async () => {
      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Empty Cloud");
      expect(output).toContain("No agents here");
    });

    it("should not show any spawn commands", async () => {
      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).not.toContain("spawn claude emptycloud");
      expect(output).not.toContain("spawn codex emptycloud");
    });
  });

  // ── Quick-start auth display ────────────────────────────────────────────

  describe("quick-start auth display", () => {
    it("should show OPENROUTER_API_KEY for cloud with 'none' auth", async () => {
      await cmdCloudInfo("local");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should not show 'none' as a command for cloud with 'none' auth", async () => {
      await cmdCloudInfo("local");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      // "none" should not appear as an auth instruction in quick-start
      const quickStartLines = output.split("\n");
      const noneAsCommand = quickStartLines.some(
        (line: string) => line.includes("Quick start") === false && line.trim() === "none",
      );
      expect(noneAsCommand).toBe(false);
    });

    it("should show cloud-specific auth env var for cloud with env var auth", async () => {
      await cmdCloudInfo("authcloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("AUTH_TOKEN");
      expect(output).toContain("OPENROUTER_API_KEY");
    });
  });

  // ── Error paths ─────────────────────────────────────────────────────────

  describe("error paths", () => {
    it("should exit with error for unknown cloud", async () => {
      await expect(cmdCloudInfo("nonexistent")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown cloud"))).toBe(true);
    });

    it("should suggest spawn clouds command for unknown cloud", async () => {
      await expect(cmdCloudInfo("nonexistent")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });

    it("should reject cloud with invalid identifier characters", async () => {
      await expect(cmdCloudInfo("../hack")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud with uppercase letters", async () => {
      await expect(cmdCloudInfo("Sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject empty cloud name", async () => {
      await expect(cmdCloudInfo("")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject whitespace-only cloud name", async () => {
      await expect(cmdCloudInfo("   ")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud name with shell metacharacters", async () => {
      await expect(cmdCloudInfo("sprite;rm")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud name exceeding 64 characters", async () => {
      const longName = "a".repeat(65);
      await expect(cmdCloudInfo(longName)).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Typo suggestions ───────────────────────────────────────────────────

  describe("typo suggestions", () => {
    it("should suggest closest cloud name for typo", async () => {
      // "sprit" is distance 1 from "sprite"
      await expect(cmdCloudInfo("sprit")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(true);
    });

    it("should not suggest when input is very different", async () => {
      // "kubernetes" is far from any cloud name
      await expect(cmdCloudInfo("kubernetes")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.every((msg: string) => !msg.includes("Did you mean"))).toBe(true);
    });
  });
});
