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
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
    "upcloud/codex": "implemented",
    "oauthcloud/claude": "implemented",
    "oauthcloud/codex": "missing",
    "nonecloud/claude": "implemented",
    "nonecloud/codex": "implemented",
    // emptycloud has no implementations
    "emptycloud/claude": "missing",
    "emptycloud/codex": "missing",
  },
};

// Manifest with many agents to test the "Not yet available" cutoff at > 5
const manyAgentManifest: Manifest = {
  agents: {
    claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
    codex: { name: "Codex", description: "b", url: "", install: "", launch: "", env: {} },
    cline: { name: "Cline", description: "c", url: "", install: "", launch: "", env: {} },
    gptme: { name: "GPTMe", description: "d", url: "", install: "", launch: "", env: {} },
    continue: { name: "Continue", description: "e", url: "", install: "", launch: "", env: {} },
    plandex: { name: "Plandex", description: "f", url: "", install: "", launch: "", env: {} },
    opencode: { name: "OpenCode", description: "g", url: "", install: "", launch: "", env: {} },
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
    "testcloud/codex": "missing",
    "testcloud/cline": "missing",
    "testcloud/gptme": "missing",
    "testcloud/continue": "missing",
    "testcloud/plandex": "missing",
    "testcloud/opencode": "missing",
  },
};

// Manifest with a few missing agents (under the 5 threshold)
const fewMissingManifest: Manifest = {
  agents: {
    claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
    codex: { name: "Codex", description: "b", url: "", install: "", launch: "", env: {} },
    gptme: { name: "GPTMe", description: "c", url: "", install: "", launch: "", env: {} },
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
    "testcloud/codex": "missing",
    "testcloud/gptme": "missing",
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
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

const { cmdCloudInfo, cmdAgentInfo } = await import("../commands.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cmdCloudInfo - Quick start with multi-auth", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedORKey: string | undefined;
  let savedEnvVars: Record<string, string | undefined>;

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

    savedORKey = process.env.OPENROUTER_API_KEY;
    savedEnvVars = {
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;

    originalFetch = global.fetch;
    await setupManifest(multiAuthManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    if (savedORKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedORKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
    for (const [key, value] of Object.entries(savedEnvVars)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
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

    it("should show URL hint only on first auth var line", async () => {
      await cmdCloudInfo("upcloud");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      // Find lines in quick-start section containing auth env vars
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const usernameLine = afterQuickStart.find(
        (l: string) => l.includes("UPCLOUD_USERNAME")
      );
      const passwordLine = afterQuickStart.find(
        (l: string) => l.includes("UPCLOUD_PASSWORD")
      );
      expect(usernameLine).toBeDefined();
      expect(passwordLine).toBeDefined();
      // URL hint should appear on the first auth var line
      expect(usernameLine).toContain("upcloud.com");
      // URL hint should NOT be repeated on the second auth var line
      expect(passwordLine).not.toContain("upcloud.com");
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
      // No cloud-specific auth vars should appear as export lines
      const nonOrExportLines = lines.filter(
        (l: string) => l.includes("export") && !l.includes("OPENROUTER")
      );
      expect(nonOrExportLines).toHaveLength(0);
      // OPENROUTER_API_KEY should still appear (as export or as "set")
      const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toBeDefined();
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
      expect(output).not.toContain("spawn codex emptycloud");
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
      expect(output).toContain("Codex");
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
    it("should NOT show 'Not yet available' section", async () => {
      await setupManifest(manyAgentManifest);
      await cmdCloudInfo("testcloud");
      const output = getOutput();
      expect(output).not.toContain("Not yet available");
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
          codex: { name: "Codex", description: "b", url: "", install: "", launch: "", env: {} },
          cline: { name: "Cline", description: "c", url: "", install: "", launch: "", env: {} },
          gptme: { name: "GPTMe", description: "d", url: "", install: "", launch: "", env: {} },
          continue: { name: "Continue", description: "e", url: "", install: "", launch: "", env: {} },
          opencode: { name: "OpenCode", description: "f", url: "", install: "", launch: "", env: {} },
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
          "testcloud/codex": "missing",
          "testcloud/cline": "missing",
          "testcloud/gptme": "missing",
          "testcloud/continue": "missing",
          "testcloud/opencode": "missing",
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
      // upcloud has both claude and codex implemented
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
  let savedORKey: string | undefined;
  let savedEnvVars: Record<string, string | undefined>;

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

    savedORKey = process.env.OPENROUTER_API_KEY;
    savedEnvVars = {
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;

    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    if (savedORKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedORKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
    for (const [key, value] of Object.entries(savedEnvVars)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
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

    it("should show ALL auth env vars for multi-credential clouds", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // Both vars from "UPCLOUD_USERNAME + UPCLOUD_PASSWORD" should appear
      expect(output).toContain("UPCLOUD_USERNAME");
      expect(output).toContain("UPCLOUD_PASSWORD");
    });

    it("should show URL hint only on first auth var, not repeated", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const usernameLine = afterQuickStart.find(
        (l: string) => l.includes("UPCLOUD_USERNAME")
      );
      const passwordLine = afterQuickStart.find(
        (l: string) => l.includes("UPCLOUD_PASSWORD")
      );
      expect(usernameLine).toBeDefined();
      expect(passwordLine).toBeDefined();
      // URL hint should appear on the first auth var line
      expect(usernameLine).toContain("upcloud.com");
      // URL hint should NOT be repeated on the second auth var line
      expect(passwordLine).not.toContain("upcloud.com");
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
      // No cloud-specific auth vars should appear as export lines
      const lines = consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
      const nonOrExportLines = lines.filter(
        (l: string) => l.includes("export") && !l.includes("OPENROUTER")
      );
      expect(nonOrExportLines).toHaveLength(0);
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

// ── Credential status indicators in Quick start ──────────────────────────────

describe("Quick start credential status indicators", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedEnv: Record<string, string | undefined>;

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

  function getLines(): string[] {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" "));
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

    // Save env vars we'll modify
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
      EMPTY_TOKEN: process.env.EMPTY_TOKEN,
    };
    // Clear all so each test starts clean and sets only what it needs
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;
    delete process.env.EMPTY_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();

    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("cmdCloudInfo with credentials set", () => {
    it("should show 'set' indicator when OPENROUTER_API_KEY is set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const lines = getLines();
      const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toBeDefined();
      expect(orLine).toContain("set");
      expect(orLine).not.toContain("export");
    });

    it("should show 'export' instruction when OPENROUTER_API_KEY is NOT set", async () => {
      delete process.env.OPENROUTER_API_KEY;
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const lines = getLines();
      const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toBeDefined();
      expect(orLine).toContain("export");
    });

    it("should show 'set' for cloud auth var when it is configured", async () => {
      process.env.UPCLOUD_USERNAME = "testuser";
      delete process.env.UPCLOUD_PASSWORD;
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const lines = getLines();
      // Find quick-start lines (after the "Quick start:" header, not the Auth: header line)
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const userLine = afterQuickStart.find((l: string) => l.includes("UPCLOUD_USERNAME"));
      const passLine = afterQuickStart.find((l: string) => l.includes("UPCLOUD_PASSWORD"));
      expect(userLine).toBeDefined();
      expect(userLine).toContain("set");
      expect(userLine).not.toContain("export");
      expect(passLine).toBeDefined();
      expect(passLine).toContain("export");
    });
  });

  describe("cmdAgentInfo with credentials set", () => {
    it("should show 'set' for OPENROUTER_API_KEY when configured", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getLines();
      const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toBeDefined();
      expect(orLine).toContain("set");
      expect(orLine).not.toContain("export");
    });

    it("should show 'export' for OPENROUTER_API_KEY when NOT configured", async () => {
      delete process.env.OPENROUTER_API_KEY;
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getLines();
      const orLine = lines.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toBeDefined();
      expect(orLine).toContain("export");
    });

    it("should show 'set' for cloud auth var in agent quick-start when configured", async () => {
      process.env.UPCLOUD_USERNAME = "testuser";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getLines();
      const authLine = lines.find((l: string) => l.includes("UPCLOUD_USERNAME"));
      expect(authLine).toBeDefined();
      expect(authLine).toContain("set");
      expect(authLine).not.toContain("export");
    });
  });

  describe("cmdCloudInfo 'ready to go' shortcut", () => {
    it("should show 'ready to go' when all credentials are set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).toContain("ready to go");
      expect(output).toContain("spawn claude upcloud");
    });

    it("should NOT show export instructions when all creds are ready", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const lines = getLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const exportLines = afterQuickStart.filter((l: string) => l.includes("export"));
      expect(exportLines).toHaveLength(0);
    });

    it("should NOT show 'ready to go' when OPENROUTER_API_KEY is missing", async () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
    });

    it("should NOT show 'ready to go' when cloud auth var is missing", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      delete process.env.UPCLOUD_USERNAME;
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("upcloud");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
    });

    it("should show 'ready to go' for none-auth cloud when OPENROUTER_API_KEY is set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("nonecloud");
      const output = getOutput();
      expect(output).toContain("ready to go");
    });

    it("should NOT show 'ready to go' for cloud with no implemented agents", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.EMPTY_TOKEN = "test-token";
      await setupManifest(multiAuthManifest);
      await cmdCloudInfo("emptycloud");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
    });
  });

  describe("cmdAgentInfo 'ready to go' shortcut", () => {
    it("should show 'ready to go' when first cloud has all creds set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("ready to go");
      expect(output).toContain("spawn claude upcloud");
    });

    it("should NOT show 'ready to go' when OPENROUTER_API_KEY is missing", async () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
    });

    it("should show 'ready to go' for agent with none-auth cloud when OPENROUTER_API_KEY is set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      const noneFirstManifest: Manifest = {
        agents: {
          claude: {
            name: "Claude Code", description: "AI assistant",
            url: "https://claude.ai", install: "npm install -g claude",
            launch: "claude", env: {},
          },
        },
        clouds: {
          nonecloud: {
            name: "Local Runner", description: "Run locally",
            url: "https://example.com", type: "local", auth: "none",
            provision_method: "none", exec_method: "bash", interactive_method: "bash",
          },
        },
        matrix: { "nonecloud/claude": "implemented" },
      };
      await setupManifest(noneFirstManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("ready to go");
    });

    it("should NOT show export instructions when all creds are ready", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const nextLine = lines[quickStartIdx + 1];
      expect(nextLine).toContain("spawn claude");
      const afterQuickStart = lines.slice(quickStartIdx + 1, quickStartIdx + 3);
      const exportLines = afterQuickStart.filter((l: string) => l.includes("export"));
      expect(exportLines).toHaveLength(0);
    });
  });
});
