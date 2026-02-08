import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cmdRun,
  cmdList,
  cmdAgents,
  cmdClouds,
  cmdAgentInfo,
  cmdHelp,
} from "../commands";
import type { Manifest } from "../manifest";

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

// Mock the manifest module
vi.mock("../manifest", () => ({
  loadManifest: vi.fn(),
  agentKeys: vi.fn(),
  cloudKeys: vi.fn(),
  matrixStatus: vi.fn(),
  countImplemented: vi.fn(),
  RAW_BASE: "https://raw.githubusercontent.com/OpenRouterTeam/spawn/main",
  REPO: "OpenRouterTeam/spawn",
  CACHE_DIR: "/tmp/spawn",
}));

// Mock clack/prompts
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(),
  select: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("commands", () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    // Mock console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`);
    });

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("cmdHelp", () => {
    it("should print help text", () => {
      cmdHelp();
      expect(consoleLogSpy).toHaveBeenCalled();
      const helpText = consoleLogSpy.mock.calls.join("\n");
      expect(helpText).toContain("spawn");
      expect(helpText).toContain("USAGE");
      expect(helpText).toContain("EXAMPLES");
    });
  });

  describe("cmdList", () => {
    it("should display matrix table with all agents and clouds", async () => {
      const { loadManifest, agentKeys, cloudKeys, matrixStatus, countImplemented } = await import(
        "../manifest"
      );

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(agentKeys).mockReturnValue(["claude", "aider"]);
      vi.mocked(cloudKeys).mockReturnValue(["sprite", "hetzner"]);
      vi.mocked(matrixStatus).mockImplementation((m, cloud, agent) => {
        return mockManifest.matrix[`${cloud}/${agent}`] || "missing";
      });
      vi.mocked(countImplemented).mockReturnValue(3);

      await cmdList();

      expect(loadManifest).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();

      const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("Aider");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("3/4 combinations implemented");
    });
  });

  describe("cmdAgents", () => {
    it("should list all agents with descriptions", async () => {
      const { loadManifest, agentKeys } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(agentKeys).mockReturnValue(["claude", "aider"]);

      await cmdAgents();

      expect(loadManifest).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();

      const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("AI coding assistant");
      expect(output).toContain("Aider");
      expect(output).toContain("AI pair programmer");
    });
  });

  describe("cmdClouds", () => {
    it("should list all clouds with descriptions", async () => {
      const { loadManifest, cloudKeys } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(cloudKeys).mockReturnValue(["sprite", "hetzner"]);

      await cmdClouds();

      expect(loadManifest).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();

      const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Sprite");
      expect(output).toContain("Lightweight VMs");
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("European cloud provider");
    });
  });

  describe("cmdAgentInfo", () => {
    it("should show info for a valid agent with implemented clouds", async () => {
      const { loadManifest, cloudKeys, matrixStatus } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(cloudKeys).mockReturnValue(["sprite", "hetzner"]);
      vi.mocked(matrixStatus).mockImplementation((m, cloud, agent) => {
        return mockManifest.matrix[`${cloud}/${agent}`] || "missing";
      });

      await cmdAgentInfo("claude");

      expect(loadManifest).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();

      const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Claude Code");
      expect(output).toContain("AI coding assistant");
      expect(output).toContain("Sprite");
      expect(output).toContain("Hetzner Cloud");
    });

    it("should show no clouds message when agent has no implementations", async () => {
      const { loadManifest, cloudKeys, matrixStatus } = await import("../manifest");

      const noImplManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "missing",
          "hetzner/claude": "missing",
        },
      };

      vi.mocked(loadManifest).mockResolvedValue(noImplManifest);
      vi.mocked(cloudKeys).mockReturnValue(["sprite", "hetzner"]);
      vi.mocked(matrixStatus).mockReturnValue("missing");

      await cmdAgentInfo("claude");

      const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("No implemented clouds yet");
    });

    it("should exit with error for unknown agent", async () => {
      const { loadManifest } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);

      await expect(cmdAgentInfo("unknown-agent")).rejects.toThrow("process.exit(1)");
    });
  });

  describe("cmdRun", () => {
    it("should launch script for valid agent and cloud", async () => {
      const { loadManifest, matrixStatus } = await import("../manifest");
      const { spawn } = await import("child_process");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(matrixStatus).mockReturnValue("implemented");

      // Mock successful script download and execution
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "#!/bin/bash\necho 'test script'",
      });

      const mockChild = {
        on: vi.fn((event, handler) => {
          if (event === "close") {
            handler(0);
          }
          return mockChild;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      await cmdRun("claude", "sprite");

      expect(loadManifest).toHaveBeenCalled();
      expect(matrixStatus).toHaveBeenCalledWith(mockManifest, "sprite", "claude");
      expect(spawn).toHaveBeenCalledWith(
        "bash",
        ["-c", "#!/bin/bash\necho 'test script'"],
        expect.objectContaining({
          stdio: "inherit",
        })
      );
    });

    it("should exit with error for unknown agent", async () => {
      const { loadManifest } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);

      await expect(cmdRun("unknown-agent", "sprite")).rejects.toThrow("process.exit(1)");
    });

    it("should exit with error for unknown cloud", async () => {
      const { loadManifest } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);

      await expect(cmdRun("claude", "unknown-cloud")).rejects.toThrow("process.exit(1)");
    });

    it("should exit with error for unimplemented combination", async () => {
      const { loadManifest, matrixStatus } = await import("../manifest");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(matrixStatus).mockReturnValue("missing");

      await expect(cmdRun("aider", "hetzner")).rejects.toThrow("process.exit(1)");
    });

    it("should fallback to GitHub raw URL when primary URL fails", async () => {
      const { loadManifest, matrixStatus } = await import("../manifest");
      const { spawn } = await import("child_process");

      vi.mocked(loadManifest).mockResolvedValue(mockManifest);
      vi.mocked(matrixStatus).mockReturnValue("implemented");

      // Mock primary URL failure, GitHub URL success
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "#!/bin/bash\necho 'github fallback'",
        });

      const mockChild = {
        on: vi.fn((event, handler) => {
          if (event === "close") {
            handler(0);
          }
          return mockChild;
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      await cmdRun("claude", "sprite");

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("raw.githubusercontent.com")
      );
    });
  });
});
