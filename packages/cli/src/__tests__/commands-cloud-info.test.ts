import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for cmdCloudInfo and related cloud validation paths in commands.ts.
 *
 * cmdCloudInfo had zero test coverage despite being a user-facing command.
 * These tests exercise the actual exported function with:
 * - Valid cloud names showing agent availability
 * - Cloud notes display
 * - "No implemented agents" fallback message
 * - Invalid/unknown cloud error paths
 * - Typo suggestion via findClosestMatch integration
 * - validateAndGetCloud identifier + empty string rejection
 */

const mockManifest = createMockManifest();

// Extended manifest with cloud notes and an agent-less cloud for testing
const manifestWithNotes = {
  ...mockManifest,
  clouds: {
    ...mockManifest.clouds,
    emptycloud: {
      name: "Empty Cloud",
      description: "Cloud with no agents",
      url: "https://empty.cloud",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
      notes: "This cloud requires special setup instructions.",
    },
  },
};

// Manifest where a cloud has notes
const manifestWithCloudNotes = {
  ...mockManifest,
  clouds: {
    ...mockManifest.clouds,
    sprite: {
      ...mockManifest.clouds.sprite,
      notes: "Requires sprite-cli to be installed.",
    },
  },
};

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

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((_code?: number): never => {
      throw new Error("process.exit");
    });

    originalFetch = global.fetch;
    global.fetch = mock(async () => new Response(JSON.stringify(mockManifest)));

    await loadManifest(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── Happy path: valid cloud with implemented agents ───────────────

  describe("valid cloud with agents", () => {
    it("should display cloud name and description", async () => {
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
      expect(output).toContain("spawn claude hetzner");
      expect(output).not.toContain("spawn codex hetzner");
    });

    it("should show hetzner description", async () => {
      await cmdCloudInfo("hetzner");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("European cloud provider");
    });

    it("should show cloud type in output", async () => {
      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Type: vm");
    });

    it("should show cloud type for hetzner", async () => {
      await cmdCloudInfo("hetzner");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Type: cloud");
    });
  });

  // ── Cloud with notes ──────────────────────────────────────────────

  describe("cloud with notes field", () => {
    it("should display notes when cloud has notes", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manifestWithCloudNotes)));
      await loadManifest(true);

      await cmdCloudInfo("sprite");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Requires sprite-cli to be installed");
    });
  });

  // ── Cloud with no implemented agents ──────────────────────────────

  describe("cloud with no implemented agents", () => {
    it("should show no-agents message", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manifestWithNotes)));
      await loadManifest(true);

      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("No implemented agents");
    });

    it("should still show cloud name for agent-less cloud", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manifestWithNotes)));
      await loadManifest(true);

      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("Empty Cloud");
      expect(output).toContain("Cloud with no agents");
    });

    it("should display notes for agent-less cloud", async () => {
      global.fetch = mock(async () => new Response(JSON.stringify(manifestWithNotes)));
      await loadManifest(true);

      await cmdCloudInfo("emptycloud");
      const output = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
      expect(output).toContain("special setup instructions");
    });
  });

  // ── Error paths: unknown cloud ────────────────────────────────────

  describe("unknown cloud", () => {
    it("should exit with error for unknown cloud", async () => {
      await expect(cmdCloudInfo("nonexistent")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);

      const errorCalls = mockLogError.mock.calls.map((c: any[]) => c.join(" "));
      expect(errorCalls.some((msg: string) => msg.includes("Unknown cloud"))).toBe(true);
    });

    it("should suggest spawn clouds command", async () => {
      await expect(cmdCloudInfo("nonexistent")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });

    it("should suggest closest match for typo", async () => {
      await expect(cmdCloudInfo("sprit")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("sprite"))).toBe(true);
    });

    it("should suggest closest match for different typo", async () => {
      await expect(cmdCloudInfo("hetzne")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("hetzner"))).toBe(true);
    });

    it("should not suggest match for very different name", async () => {
      await expect(cmdCloudInfo("kubernetes")).rejects.toThrow("process.exit");

      const infoCalls = mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
      expect(infoCalls.some((msg: string) => msg.includes("Did you mean"))).toBe(false);
      expect(infoCalls.some((msg: string) => msg.includes("spawn clouds"))).toBe(true);
    });
  });

  // ── Error paths: invalid identifier ───────────────────────────────

  describe("invalid cloud identifier", () => {
    it("should reject cloud with path traversal characters", async () => {
      await expect(cmdCloudInfo("../etc")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud with uppercase letters", async () => {
      await expect(cmdCloudInfo("Sprite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud with shell metacharacters", async () => {
      await expect(cmdCloudInfo("sprite;rm")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud with spaces", async () => {
      await expect(cmdCloudInfo("my cloud")).rejects.toThrow("process.exit");
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

    it("should reject cloud name exceeding 64 characters", async () => {
      const longName = "a".repeat(65);
      await expect(cmdCloudInfo(longName)).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should reject cloud name with dollar sign", async () => {
      await expect(cmdCloudInfo("spr$ite")).rejects.toThrow("process.exit");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── Spinner behavior ──────────────────────────────────────────────

  describe("spinner usage", () => {
    it("should use spinner while loading manifest", async () => {
      await cmdCloudInfo("sprite");
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalled();
    });
  });
});
