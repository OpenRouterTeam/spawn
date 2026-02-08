import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  cmdRun,
  cmdList,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdHelp,
} from "../commands";
import type { Manifest } from "../manifest";

// Test helpers
function createConsoleMocks() {
  return {
    log: spyOn(console, "log").mockImplementation(() => {}),
    error: spyOn(console, "error").mockImplementation(() => {}),
  };
}

function createProcessExitMock() {
  return spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as any);
}

function restoreMocks(...mocks: Array<{ mockRestore?: () => void } | undefined>) {
  mocks.forEach(mock => mock?.mockRestore());
}

// Mock manifest data
const mockManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
    },
    aider: {
      name: "Aider",
      description: "AI pair programmer",
      url: "https://aider.chat",
      install: "pip install aider-chat",
      launch: "aider",
      env: {
        OPENAI_API_KEY: "test-key",
      },
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
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/aider": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/aider": "missing",
  },
};

// Note: Bun test doesn't support module mocking the same way as vitest
// These tests require refactoring commands.ts to use dependency injection

describe("commands", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let processExitSpy: ReturnType<typeof createProcessExitMock>;

  beforeEach(() => {
    consoleMocks = createConsoleMocks();
    processExitSpy = createProcessExitMock();
  });

  afterEach(() => {
    restoreMocks(consoleMocks.log, consoleMocks.error, processExitSpy);
  });

  describe("cmdHelp", () => {
    it("should print help text", () => {
      cmdHelp();
      expect(consoleMocks.log).toHaveBeenCalled();
      const helpText = consoleMocks.log.mock.calls.join("\n");
      expect(helpText).toContain("spawn");
      expect(helpText).toContain("USAGE");
      expect(helpText).toContain("EXAMPLES");
    });
  });

  // TODO: These tests need refactoring - bun doesn't support module mocking
  // Commands.ts should be refactored to use dependency injection for testability

  describe.skip("cmdList - needs dependency injection", () => {
    it("should display matrix table with all agents and clouds", async () => {
      // Skipped: requires module mocking unsupported by bun
    });
  });

  describe.skip("cmdAgents - needs dependency injection", () => {
    it("should list all agents with descriptions", async () => {
      // Skipped: requires module mocking unsupported by bun
    });
  });

  describe.skip("cmdClouds - needs dependency injection", () => {
    it("should list all clouds with descriptions", async () => {
      // Skipped: requires module mocking unsupported by bun
    });
  });

  describe.skip("cmdAgentInfo - needs dependency injection", () => {
    it("should show info for a valid agent with implemented clouds", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should show no clouds message when agent has no implementations", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should exit with error for unknown agent", async () => {
      // Skipped: requires module mocking unsupported by bun
    });
  });

  describe.skip("cmdRun - needs dependency injection", () => {
    it("should launch script for valid agent and cloud", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should exit with error for unknown agent", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should exit with error for unknown cloud", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should exit with error for unimplemented combination", async () => {
      // Skipped: requires module mocking unsupported by bun
    });

    it("should fallback to GitHub raw URL when primary URL fails", async () => {
      // Skipped: requires module mocking unsupported by bun
    });
  });
});
