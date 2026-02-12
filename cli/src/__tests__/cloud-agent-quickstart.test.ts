import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for the Quick start section in cmdCloudInfo and cmdAgentInfo,
 * and the "Not yet available" section in cmdCloudInfo's printAgentList.
 *
 * Existing tests cover:
 * - cmdCloudInfo basic display, notes, no-agent fallback (cloud-info.test.ts)
 * - cmdCloudInfo basic auth display for "none" and single env var (cloud-info.test.ts)
 * - cmdAgentInfo happy path and error paths (commands-display.test.ts)
 * - parseAuthEnvVars in isolation (commands-exported-utils.test.ts)
 *
 * This file covers the UNTESTED integration paths:
 * - printCloudQuickStart with multi-auth env vars (e.g., USERNAME + PASSWORD)
 * - printCloudQuickStart URL hint only on first auth var (not repeated)
 * - printCloudQuickStart with non-"none" auth string that yields no env vars
 * - printCloudQuickStart when no implemented agents (no example command)
 * - printAgentList "Not yet available" list when missingAgents <= 5
 * - printAgentList no "Not yet available" when missingAgents > 5
 * - cmdAgentInfo Quick start with multi-auth cloud as first available
 * - cmdAgentInfo Quick start with "none" auth cloud (no extra export line)
 *
 * Agent: test-engineer
 */

// ── Mock manifests ────────────────────────────────────────────────────────────

const multiAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g claude",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
    aider: {
      name: "Aider",
      description: "AI pair programmer",
      url: "https://aider.chat",
      install: "pip install aider-chat",
      launch: "aider",
      env: { OPENAI_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    upcloud: {
      name: "UpCloud",
      description: "European cloud hosting",
      url: "https://upcloud.com/signup",
      type: "cloud",
      auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    oauthcloud: {
      name: "OAuth Cloud",
      description: "Cloud with browser auth",
      url: "https://oauthcloud.example.com",
      type: "cloud",
      auth: "OAuth + browser",
      provision_method: "cli",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    nonecloud: {
      name: "Local Runner",
      description: "Run agents locally",
      url: "https://example.com",
      type: "local",
      auth: "none",
      provision_method: "none",
      exec_method: "bash",
      interactive_method: "bash",
    },
    emptycloud: {
      name: "Empty Cloud",
      description: "No agents here",
      url: "https://empty.example.com",
      type: "cloud",
      auth: "EMPTY_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "upcloud/claude": "implemented",
    "upcloud/aider": "implemented",
    "oauthcloud/claude": "implemented",
    "oauthcloud/aider": "missing",
    "nonecloud/claude": "implemented",
    "nonecloud/aider": "implemented",
    // emptycloud has no implementations
    "emptycloud/claude": "missing",
    "emptycloud/aider": "missing",
  },
};

// Manifest with many agents to test the "Not yet available" cutoff at > 5
const manyAgentManifest: Manifest = {
  agents: {
    claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
    aider: { name: "Aider", description: "b", url: "", install: "", launch: "", env: {} },
    codex: { name: "Codex", description: "c", url: "", install: "", launch: "", env: {} },
    cline: { name: "Cline", description: "d", url: "", install: "", launch: "", env: {} },
    continue: { name: "Continue", description: "e", url: "", install: "", launch: "", env: {} },
    goose: { name: "Goose", description: "f", url: "", install: "", launch: "", env: {} },
    gemini: { name: "Gemini CLI", description: "g", url: "", install: "", launch: "", env: {} },
  },
  clouds: {
    testcloud: {
      name: "Test Cloud",
      description: "Test provider",
      url: "https://test.example.com",
      type: "cloud",
      auth: "TEST_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "testcloud/claude": "implemented",
    // All others are missing - that's 6 missing agents (> 5 threshold)
    "testcloud/aider": "missing",
    "testcloud/codex": "missing",
    "testcloud/cline": "missing",
    "testcloud/continue": "missing",
    "testcloud/goose": "missing",
    "testcloud/gemini": "missing",
  },
};

// Manifest with a few missing agents (under the 5 threshold)
const fewMissingManifest: Manifest = {
  agents: {
    claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
    aider: { name: "Aider", description: "b", url: "", install: "", launch: "", env: {} },
    codex: { name: "Codex", description: "c", url: "", install: "", launch: "", env: {} },
  },
  clouds: {
    testcloud: {
      name: "Test Cloud",
      description: "Test provider",
      url: "https://test.example.com",
      type: "cloud",
      auth: "TEST_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "testcloud/claude": "implemented",
    "testcloud/aider": "missing",
    "testcloud/codex": "missing",
  },
};

// ── Mock setup ────────────────────────────────────────────────────────────────

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
    success: mock(() => {}),
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  isCancel: () => false,
}));

const { cmdCloudInfo, cmdAgentInfo } = await import("../commands.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cmdCloudInfo - Quick start with multi-auth", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
    await setupManifest(multiAuthManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  // ── Multi-auth env vars ──────────────────────────────────────────────

  describe("multi-auth cloud (UPCLOUD_USERNAME + UPCLOUD_PASSWORD)", () => {
    it("should show both auth env vars in Quick start", async () => {
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("UPCLOUD_USERNAME");
      expect(output).toContain("UPCLOUD_PASSWORD");
    });

    it("should show OPENROUTER_API_KEY in Quick start", async () => {
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should show URL hint only on first auth var export line", async () => {
      await cmdCloudInfo("upcloud");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      // Find lines containing the export command for auth env vars
      const usernameExportLines = lines.filter(
        (l: string) => l.includes("export") && l.includes("UPCLOUD_USERNAME")
      );
      const passwordExportLines = lines.filter(
        (l: string) => l.includes("export") && l.includes("UPCLOUD_PASSWORD")
      );
      expect(usernameExportLines.length).toBeGreaterThan(0);
      expect(passwordExportLines.length).toBeGreaterThan(0);
      // URL hint should appear on the first auth var export line
      const firstAuthLine = usernameExportLines[0];
      expect(firstAuthLine).toContain("upcloud.com");
      // URL hint should NOT be repeated on the second auth var export line
      const secondAuthLine = passwordExportLines[0];
      expect(secondAuthLine).not.toContain("upcloud.com");
    });

    it("should show example launch command with first implemented agent", async () => {
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("spawn claude upcloud");
    });
  });

  // ── OAuth auth (yields no env vars) ─────────────────────────────────

  describe("OAuth auth cloud (no parseable env vars)", () => {
    it("should show auth string as-is when no env vars parsed", async () => {
      await cmdCloudInfo("oauthcloud");
      const output = getOutput();
      // "OAuth + browser" yields no valid env var names from parseAuthEnvVars
      // So the code shows: Auth: OAuth + browser
      expect(output).toContain("Auth:");
      expect(output).toContain("OAuth");
    });

    it("should still show OPENROUTER_API_KEY", async () => {
      await cmdCloudInfo("oauthcloud");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should not show export lines for non-env-var auth", async () => {
      await cmdCloudInfo("oauthcloud");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      // Should not have "export OAUTH..." or "export BROWSER..."
      const exportLines = lines.filter((l: string) =>
        l.includes("export") && !l.includes("OPENROUTER")
      );
      expect(exportLines).toHaveLength(0);
    });
  });

  // ── "none" auth ─────────────────────────────────────────────────────

  describe("none auth cloud", () => {
    it("should not show any auth export besides OPENROUTER_API_KEY", async () => {
      await cmdCloudInfo("nonecloud");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      // Count export lines - should only be OPENROUTER_API_KEY
      const exportLines = lines.filter((l: string) => l.includes("export"));
      expect(exportLines.length).toBe(1);
      expect(exportLines[0]).toContain("OPENROUTER_API_KEY");
    });

    it("should show Auth: none in the type/auth header but not in quick-start", async () => {
      await cmdCloudInfo("nonecloud");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      // "Auth: none" appears in the Type/Auth header line (expected)
      const headerLine = lines.find((l: string) => l.includes("Type:") && l.includes("Auth:"));
      expect(headerLine).toBeDefined();
      // The Quick start section should NOT show a separate auth hint line
      // (because "none" auth means no auth vars needed)
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      // After Quick start, the only export should be OPENROUTER_API_KEY
      const afterQuickStart = lines.slice(quickStartIdx);
      const authHintLines = afterQuickStart.filter(
        (l: string) => l.includes("Auth:") && !l.includes("Type:")
      );
      expect(authHintLines).toHaveLength(0);
    });
  });

  // ── Cloud with no implemented agents ────────────────────────────────

  describe("cloud with no implemented agents (no example command)", () => {
    it("should show Quick start without spawn example", async () => {
      await cmdCloudInfo("emptycloud");
      const output = getOutput();
      expect(output).toContain("Quick start");
      // No agents means no "spawn <agent> emptycloud" example
      expect(output).not.toContain("spawn claude emptycloud");
      expect(output).not.toContain("spawn aider emptycloud");
    });

    it("should still show auth env var in Quick start", async () => {
      await cmdCloudInfo("emptycloud");
      const output = getOutput();
      expect(output).toContain("EMPTY_TOKEN");
    });
  });
});

// ── printAgentList "Not yet available" section ────────────────────────────────

describe("cmdCloudInfo - Not yet available agents", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  describe("few missing agents (2 missing, <= 5 threshold)", () => {
    it("should show 'Not yet available' section with missing agent names", async () => {
      await setupManifest(fewMissingManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      expect(output).toContain("Not yet available");
      expect(output).toContain("Aider");
      expect(output).toContain("Codex");
    });

    it("should show implemented agent in the main list", async () => {
      await setupManifest(fewMissingManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      expect(output).toContain("spawn claude testcloud");
    });
  });

  describe("many missing agents (6 missing, > 5 threshold)", () => {
    it("should show count instead of listing individual agent names", async () => {
      await setupManifest(manyAgentManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      // Shows count summary instead of individual names
      expect(output).toContain("other agents not yet available");
      expect(output).not.toContain("Not yet available:");
    });

    it("should still show the implemented agent", async () => {
      await setupManifest(manyAgentManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      expect(output).toContain("spawn claude testcloud");
    });

    it("should show correct agent count in header", async () => {
      await setupManifest(manyAgentManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      // 1 of 7 agents implemented
      expect(output).toContain("1 of 7");
    });
  });

  describe("exactly 5 missing agents (at threshold)", () => {
    it("should show 'Not yet available' when exactly 5 missing", async () => {
      // Create manifest with 6 agents, 1 implemented, 5 missing
      const fiveMissingManifest: Manifest = {
        agents: {
          claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
          aider: { name: "Aider", description: "b", url: "", install: "", launch: "", env: {} },
          codex: { name: "Codex", description: "c", url: "", install: "", launch: "", env: {} },
          cline: { name: "Cline", description: "d", url: "", install: "", launch: "", env: {} },
          continue: { name: "Continue", description: "e", url: "", install: "", launch: "", env: {} },
          goose: { name: "Goose", description: "f", url: "", install: "", launch: "", env: {} },
        },
        clouds: {
          testcloud: {
            name: "Test Cloud",
            description: "Test",
            url: "",
            type: "cloud",
            auth: "TEST_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "testcloud/claude": "implemented",
          "testcloud/aider": "missing",
          "testcloud/codex": "missing",
          "testcloud/cline": "missing",
          "testcloud/continue": "missing",
          "testcloud/goose": "missing",
        },
      };
      await setupManifest(fiveMissingManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      expect(output).toContain("Not yet available");
    });
  });

  describe("zero missing agents (all implemented)", () => {
    it("should NOT show 'Not yet available' section", async () => {
      await setupManifest(multiAuthManifest);
      // upcloud has both claude and aider implemented
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).not.toContain("Not yet available");
    });
  });
});

// ── cmdAgentInfo Quick start with different auth patterns ─────────────────────

describe("cmdAgentInfo - Quick start auth patterns", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = spyOn(console, "error").mockImplementation(() => {});
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogWarn.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  describe("agent where first cloud has multi-auth", () => {
    it("should show the first auth env var from the first available cloud", async () => {
      // In multiAuthManifest, cloud order is upcloud, oauthcloud, nonecloud, emptycloud
      // claude is implemented on upcloud (first), so Quick start shows upcloud's auth
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // Should show UPCLOUD_USERNAME (first auth var of first cloud)
      expect(output).toContain("UPCLOUD_USERNAME");
    });

    it("should show OPENROUTER_API_KEY in Quick start", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should show example spawn command with first cloud", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude upcloud");
    });

    it("should show cloud URL hint next to auth var", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("upcloud.com");
    });
  });

  describe("agent where first cloud has 'none' auth", () => {
    it("should not show extra auth env var when cloud auth is none", async () => {
      // Create manifest where nonecloud is the only option
      const noneFirstManifest: Manifest = {
        agents: {
          claude: {
            name: "Claude Code",
            description: "AI assistant",
            url: "https://claude.ai",
            install: "npm install -g claude",
            launch: "claude",
            env: {},
          },
        },
        clouds: {
          nonecloud: {
            name: "Local Runner",
            description: "Run locally",
            url: "https://example.com",
            type: "local",
            auth: "none",
            provision_method: "none",
            exec_method: "bash",
            interactive_method: "bash",
          },
        },
        matrix: {
          "nonecloud/claude": "implemented",
        },
      };
      await setupManifest(noneFirstManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
      // Should only have 1 export line (OPENROUTER_API_KEY)
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      const exportLines = lines.filter((l: string) => l.includes("export"));
      expect(exportLines.length).toBe(1);
    });
  });

  describe("agent with no implemented clouds", () => {
    it("should NOT show Quick start section", async () => {
      // Create manifest where agent has zero implementations
      const noImplManifest: Manifest = {
        agents: {
          claude: {
            name: "Claude Code",
            description: "AI assistant",
            url: "https://claude.ai",
            install: "npm install -g claude",
            launch: "claude",
            env: {},
          },
        },
        clouds: {
          testcloud: {
            name: "Test Cloud",
            description: "Test",
            url: "",
            type: "cloud",
            auth: "TEST_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "testcloud/claude": "missing",
        },
      };
      await setupManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // No Quick start when no clouds available
      expect(output).not.toContain("Quick start");
    });

    it("should show 'No implemented clouds' message", async () => {
      const noImplManifest: Manifest = {
        agents: {
          claude: {
            name: "Claude Code",
            description: "AI assistant",
            url: "https://claude.ai",
            install: "npm install -g claude",
            launch: "claude",
            env: {},
          },
        },
        clouds: {
          testcloud: {
            name: "Test Cloud",
            description: "Test",
            url: "",
            type: "cloud",
            auth: "TEST_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "testcloud/claude": "missing",
        },
      };
      await setupManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("No implemented clouds");
    });
  });
});
