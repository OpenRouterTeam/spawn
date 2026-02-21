import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import type { Manifest } from "../manifest";

/**
 * Tests for utility functions exported from commands.ts.
 *
 * These are pure/near-pure functions that were previously not exported and
 * had zero direct test coverage:
 * - getTerminalWidth() - terminal width detection with fallback
 * - getMissingClouds() - filter missing implementations for an agent
 * - getImplementedAgents() - filter implemented agents for a cloud
 * - getImplementedClouds() - filter implemented clouds for an agent
 * - getErrorMessage() - duck-typed error message extraction
 * - calculateColumnWidth() - column width calculation with padding
 * - getStatusDescription() - HTTP status to human-readable string
 *
 * Agent: test-engineer
 */

// Mock @clack/prompts before importing commands
mock.module("@clack/prompts", () => ({
  spinner: () => ({
    start: mock(() => {}),
    stop: mock(() => {}),
    message: mock(() => {}),
  }),
  log: {
    step: mock(() => {}),
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
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

const {
  getTerminalWidth,
  getMissingClouds,
  getImplementedAgents,
  getImplementedClouds,
  getErrorMessage,
  calculateColumnWidth,
  getStatusDescription,
} = await import("../commands.js");

const mockManifest = createMockManifest();

// Extended manifest with more clouds/agents for thorough testing
const extendedManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "test" },
    },
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
      env: { OPENAI_API_KEY: "test" },
    },
    gptme: {
      name: "GPTMe",
      description: "AI terminal assistant",
      url: "https://gptme.dev",
      install: "pip install gptme",
      launch: "gptme",
      env: { OPENAI_API_KEY: "test" },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    vultr: {
      name: "Vultr",
      description: "Cloud compute",
      url: "https://vultr.com",
      type: "cloud",
      auth: "token",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "sprite/gptme": "missing",
    "hetzner/claude": "implemented",
    "hetzner/codex": "missing",
    "hetzner/gptme": "missing",
    "vultr/claude": "implemented",
    "vultr/codex": "missing",
    "vultr/gptme": "implemented",
  },
};

// All-missing manifest
const allMissingManifest: Manifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "missing",
    "sprite/codex": "missing",
    "hetzner/claude": "missing",
    "hetzner/codex": "missing",
  },
};

// All-implemented manifest
const allImplementedManifest: Manifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "implemented",
  },
};

describe("Command Utility Functions", () => {
  // ── getTerminalWidth ──────────────────────────────────────────────

  describe("getTerminalWidth", () => {
    let originalColumns: number | undefined;

    beforeEach(() => {
      originalColumns = process.stdout.columns;
    });

    afterEach(() => {
      process.stdout.columns = originalColumns!;
    });

    it("should return process.stdout.columns when defined", () => {
      process.stdout.columns = 120;
      expect(getTerminalWidth()).toBe(120);
    });

    it("should return 80 when process.stdout.columns is undefined", () => {
      (process.stdout as any).columns = undefined;
      expect(getTerminalWidth()).toBe(80);
    });

    it("should return 80 when process.stdout.columns is 0", () => {
      (process.stdout as any).columns = 0;
      expect(getTerminalWidth()).toBe(80);
    });

    it("should return the exact column count for narrow terminals", () => {
      process.stdout.columns = 40;
      expect(getTerminalWidth()).toBe(40);
    });

    it("should return the exact column count for very wide terminals", () => {
      process.stdout.columns = 300;
      expect(getTerminalWidth()).toBe(300);
    });
  });

  // ── getMissingClouds ──────────────────────────────────────────────

  describe("getMissingClouds", () => {
    it("should return missing clouds for a partially implemented agent", () => {
      const clouds = Object.keys(mockManifest.clouds);
      const missing = getMissingClouds(mockManifest, "codex", clouds);
      expect(missing).toContain("hetzner");
      expect(missing).not.toContain("sprite");
    });

    it("should return empty array for fully implemented agent", () => {
      const clouds = Object.keys(mockManifest.clouds);
      const missing = getMissingClouds(mockManifest, "claude", clouds);
      expect(missing).toEqual([]);
    });

    it("should return all clouds when agent has no implementations", () => {
      const clouds = Object.keys(allMissingManifest.clouds);
      const missing = getMissingClouds(allMissingManifest, "claude", clouds);
      expect(missing).toEqual(["sprite", "hetzner"]);
    });

    it("should return empty array when clouds list is empty", () => {
      const missing = getMissingClouds(mockManifest, "claude", []);
      expect(missing).toEqual([]);
    });

    it("should handle extended manifest with multiple missing clouds", () => {
      const clouds = Object.keys(extendedManifest.clouds);
      const missing = getMissingClouds(extendedManifest, "codex", clouds);
      expect(missing).toContain("hetzner");
      expect(missing).toContain("vultr");
      expect(missing).not.toContain("sprite");
      expect(missing).toHaveLength(2);
    });

    it("should only filter from the provided clouds list", () => {
      // Pass only a subset of clouds
      const missing = getMissingClouds(extendedManifest, "codex", ["sprite"]);
      expect(missing).toEqual([]);
    });
  });

  // ── getImplementedAgents ──────────────────────────────────────────

  describe("getImplementedAgents", () => {
    it("should return all agents for a cloud where all are implemented", () => {
      const agents = getImplementedAgents(mockManifest, "sprite");
      expect(agents).toContain("claude");
      expect(agents).toContain("codex");
      expect(agents).toHaveLength(2);
    });

    it("should return only implemented agents for partially implemented cloud", () => {
      const agents = getImplementedAgents(mockManifest, "hetzner");
      expect(agents).toContain("claude");
      expect(agents).not.toContain("codex");
      expect(agents).toHaveLength(1);
    });

    it("should return empty array when cloud has no implementations", () => {
      const agents = getImplementedAgents(allMissingManifest, "sprite");
      expect(agents).toEqual([]);
    });

    it("should return empty array for nonexistent cloud", () => {
      const agents = getImplementedAgents(mockManifest, "nonexistent");
      expect(agents).toEqual([]);
    });

    it("should handle extended manifest correctly", () => {
      const agents = getImplementedAgents(extendedManifest, "vultr");
      expect(agents).toContain("claude");
      expect(agents).toContain("gptme");
      expect(agents).not.toContain("codex");
      expect(agents).toHaveLength(2);
    });

    it("should return all agents when all are implemented", () => {
      const agents = getImplementedAgents(allImplementedManifest, "sprite");
      expect(agents).toContain("claude");
      expect(agents).toContain("codex");
      expect(agents).toHaveLength(2);
    });
  });

  // ── getImplementedClouds ──────────────────────────────────────────

  describe("getImplementedClouds", () => {
    it("should return all clouds for a fully implemented agent", () => {
      const clouds = getImplementedClouds(mockManifest, "claude");
      expect(clouds).toContain("sprite");
      expect(clouds).toContain("hetzner");
      expect(clouds).toHaveLength(2);
    });

    it("should return only implemented clouds for partially implemented agent", () => {
      const clouds = getImplementedClouds(mockManifest, "codex");
      expect(clouds).toContain("sprite");
      expect(clouds).not.toContain("hetzner");
      expect(clouds).toHaveLength(1);
    });

    it("should return empty array when agent has no implementations", () => {
      const clouds = getImplementedClouds(allMissingManifest, "claude");
      expect(clouds).toEqual([]);
    });

    it("should return empty array for nonexistent agent", () => {
      const clouds = getImplementedClouds(mockManifest, "nonexistent");
      expect(clouds).toEqual([]);
    });

    it("should handle extended manifest with three clouds", () => {
      const clouds = getImplementedClouds(extendedManifest, "claude");
      expect(clouds).toContain("sprite");
      expect(clouds).toContain("hetzner");
      expect(clouds).toContain("vultr");
      expect(clouds).toHaveLength(3);
    });

    it("should handle agent with sparse implementations", () => {
      const clouds = getImplementedClouds(extendedManifest, "gptme");
      expect(clouds).toContain("vultr");
      expect(clouds).not.toContain("sprite");
      expect(clouds).not.toContain("hetzner");
      expect(clouds).toHaveLength(1);
    });
  });

  // ── getErrorMessage ───────────────────────────────────────────────

  describe("getErrorMessage", () => {
    it("should extract message from Error objects", () => {
      expect(getErrorMessage(new Error("test error"))).toBe("test error");
    });

    it("should extract message from Error subclasses", () => {
      expect(getErrorMessage(new TypeError("type error"))).toBe("type error");
      expect(getErrorMessage(new RangeError("range error"))).toBe("range error");
    });

    it("should handle objects with message property (duck typing)", () => {
      expect(getErrorMessage({ message: "custom error" })).toBe("custom error");
    });

    it("should handle objects with numeric message", () => {
      expect(getErrorMessage({ message: 42 })).toBe("42");
    });

    it("should stringify string values", () => {
      expect(getErrorMessage("string error")).toBe("string error");
    });

    it("should stringify numbers", () => {
      expect(getErrorMessage(42)).toBe("42");
    });

    it("should stringify null", () => {
      expect(getErrorMessage(null)).toBe("null");
    });

    it("should stringify undefined", () => {
      expect(getErrorMessage(undefined)).toBe("undefined");
    });

    it("should stringify boolean", () => {
      expect(getErrorMessage(false)).toBe("false");
    });

    it("should handle empty Error message", () => {
      expect(getErrorMessage(new Error(""))).toBe("");
    });

    it("should handle object without message property", () => {
      const result = getErrorMessage({ code: "ERR" });
      expect(result).toBe("[object Object]");
    });
  });

  // ── calculateColumnWidth ──────────────────────────────────────────

  describe("calculateColumnWidth", () => {
    it("should respect minimum width when items are short", () => {
      expect(calculateColumnWidth(["a", "b"], 15)).toBe(15);
    });

    it("should expand for items longer than minimum", () => {
      // "Hello World" (11 chars) + COL_PADDING (2) = 13
      expect(calculateColumnWidth(["Hello World"], 10)).toBe(13);
    });

    it("should use the longest item to determine width", () => {
      // "very long name" (14 chars) + padding (2) = 16
      expect(calculateColumnWidth(["short", "very long name"], 10)).toBe(16);
    });

    it("should return minimum width for empty array", () => {
      expect(calculateColumnWidth([], 20)).toBe(20);
    });

    it("should handle single-character items", () => {
      // "a" (1) + padding (2) = 3, but min is 10
      expect(calculateColumnWidth(["a"], 10)).toBe(10);
    });

    it("should handle very long items", () => {
      const longItem = "A".repeat(100);
      // 100 + 2 = 102
      expect(calculateColumnWidth([longItem], 10)).toBe(102);
    });

    it("should handle items exactly at minimum width", () => {
      // Item of length 8 + padding 2 = 10, which equals minimum
      expect(calculateColumnWidth(["12345678"], 10)).toBe(10);
    });

    it("should handle items one character over minimum", () => {
      // Item of length 9 + padding 2 = 11, exceeds minimum of 10
      expect(calculateColumnWidth(["123456789"], 10)).toBe(11);
    });
  });

  // ── getStatusDescription ──────────────────────────────────────────

  describe("getStatusDescription", () => {
    it("should return 'not found' for 404", () => {
      expect(getStatusDescription(404)).toBe("not found");
    });

    it("should return HTTP code string for 200", () => {
      expect(getStatusDescription(200)).toBe("HTTP 200");
    });

    it("should return HTTP code string for 500", () => {
      expect(getStatusDescription(500)).toBe("HTTP 500");
    });

    it("should return HTTP code string for 403", () => {
      expect(getStatusDescription(403)).toBe("HTTP 403");
    });

    it("should return HTTP code string for 401", () => {
      expect(getStatusDescription(401)).toBe("HTTP 401");
    });

    it("should return HTTP code string for 502", () => {
      expect(getStatusDescription(502)).toBe("HTTP 502");
    });

    it("should return HTTP code string for 503", () => {
      expect(getStatusDescription(503)).toBe("HTTP 503");
    });
  });
});
