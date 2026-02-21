import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createMockManifest, createConsoleMocks, restoreMocks } from "./test-helpers";
import { loadManifest } from "../manifest";

/**
 * Tests for untested display details in cmdCloudInfo and cmdAgentInfo.
 *
 * Existing tests cover:
 * - commands-cloud-info.test.ts: happy path, notes, no-agents, error paths
 * - commands-display.test.ts: agent info happy path, list, agents, clouds
 *
 * This file covers the UNTESTED branches:
 * - cmdCloudInfo: "Not yet available" text when missing agents count <= 5
 * - cmdCloudInfo: "Not yet available" NOT shown when missing agents > 5
 * - cmdCloudInfo: setup URL at the bottom (github.com repo link)
 * - cmdCloudInfo: auth field in Type/Auth line
 * - cmdCloudInfo: count display (N of M agents)
 * - cmdAgentInfo: agent URL display
 * - cmdAgentInfo: agent notes display (verified via commands-display.test.ts
 *   but the URL line was not)
 * - cmdAgentInfo: count display (N of M clouds)
 *
 * Agent: test-engineer
 */

const mockManifest = createMockManifest();

// Manifest where hetzner has 1 missing agent (codex) - triggers "Not yet available"
// This is the same as the base mock manifest

// Manifest with many agents (> 5 missing) to test that "Not yet available" is NOT shown
const manyAgentsManifest = {
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
    openclaw: {
      name: "OpenClaw",
      description: "Open source agent",
      url: "https://openclaw.dev",
      install: "npm install -g openclaw",
      launch: "openclaw",
      env: { OPENAI_API_KEY: "test" },
    },
    nanoclaw: {
      name: "NanoClaw",
      description: "Lightweight agent",
      url: "https://nanoclaw.dev",
      install: "npm install -g nanoclaw",
      launch: "nanoclaw",
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
    cline: {
      name: "Cline",
      description: "AI dev tool",
      url: "https://cline.dev",
      install: "npm install -g cline",
      launch: "cline",
      env: { OPENAI_API_KEY: "test" },
    },
    kilocode: {
      name: "KiloCode",
      description: "Code assistant",
      url: "https://kilocode.dev",
      install: "npm install -g kilocode",
      launch: "kilocode",
      env: { OPENAI_API_KEY: "test" },
    },
  },
  clouds: {
    sprite: {
      name: "Sprite",
      description: "Lightweight VMs",
      url: "https://sprite.sh",
      type: "vm",
      auth: "oauth",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "missing",
    "sprite/openclaw": "missing",
    "sprite/nanoclaw": "missing",
    "sprite/gptme": "missing",
    "sprite/cline": "missing",
    "sprite/kilocode": "missing",
  },
};

// Manifest where sprite has exactly 3 missing agents (<= 5 triggers display)
const fewMissingManifest = {
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
    openclaw: {
      name: "OpenClaw",
      description: "Open source agent",
      url: "https://openclaw.dev",
      install: "npm install -g openclaw",
      launch: "openclaw",
      env: { OPENAI_API_KEY: "test" },
    },
    nanoclaw: {
      name: "NanoClaw",
      description: "Lightweight agent",
      url: "https://nanoclaw.dev",
      install: "npm install -g nanoclaw",
      launch: "nanoclaw",
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
      auth: "oauth",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "sprite/openclaw": "missing",
    "sprite/nanoclaw": "missing",
    "sprite/gptme": "missing",
  },
};

// Manifest where all agents are implemented (no "Not yet available" shown)
const allImplManifest = {
  ...mockManifest,
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "implemented",
  },
};

// Manifest with agent that has a URL and notes
const agentWithUrlManifest = {
  ...mockManifest,
  agents: {
    ...mockManifest.agents,
    claude: {
      ...mockManifest.agents.claude,
      url: "https://claude.ai/docs",
      notes: "Requires Anthropic API key for best results.",
    },
  },
};

// Manifest with env-var-based auth for quick start testing
const envVarAuthManifest = {
  ...mockManifest,
  clouds: {
    ...mockManifest.clouds,
    hetzner: {
      ...mockManifest.clouds.hetzner,
      auth: "HCLOUD_TOKEN",
    },
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
    error: mockLogError,
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

// Import commands after mock setup
const { cmdCloudInfo, cmdAgentInfo, parseAuthEnvVars } = await import("../commands.js");

describe("parseAuthEnvVars", () => {
  it("should extract single env var", () => {
    expect(parseAuthEnvVars("HCLOUD_TOKEN")).toEqual(["HCLOUD_TOKEN"]);
  });

  it("should extract multiple env vars separated by +", () => {
    expect(parseAuthEnvVars("UPCLOUD_USERNAME + UPCLOUD_PASSWORD")).toEqual([
      "UPCLOUD_USERNAME",
      "UPCLOUD_PASSWORD",
    ]);
  });

  it("should return empty array for CLI auth commands", () => {
    expect(parseAuthEnvVars("sprite login")).toEqual([]);
    expect(parseAuthEnvVars("gcloud auth login")).toEqual([]);
    expect(parseAuthEnvVars("modal setup")).toEqual([]);
  });

  it("should return empty array for short tokens", () => {
    expect(parseAuthEnvVars("token")).toEqual([]);
    expect(parseAuthEnvVars("oauth")).toEqual([]);
  });

  it("should handle complex auth strings with parenthetical notes", () => {
    const result = parseAuthEnvVars("aws configure (AWS credentials)");
    // "aws", "configure", "AWS", "credentials" - none match the env var pattern
    expect(result).toEqual([]);
  });

  it("should extract four env vars from Contabo-style auth", () => {
    expect(
      parseAuthEnvVars(
        "CONTABO_CLIENT_ID + CONTABO_CLIENT_SECRET + CONTABO_API_USER + CONTABO_API_PASSWORD"
      )
    ).toEqual([
      "CONTABO_CLIENT_ID",
      "CONTABO_CLIENT_SECRET",
      "CONTABO_API_USER",
      "CONTABO_API_PASSWORD",
    ]);
  });
});

describe("cmdCloudInfo - missing agents display", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    originalFetch = global.fetch;
    await setManifest(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
  });

  // ── "Not yet available" display ──────────────────────────────────

  describe("Not yet available text", () => {
    it("should show 'Not yet available' when cloud has 1 missing agent (<=5)", async () => {
      // hetzner has claude (implemented) but codex (missing) = 1 missing agent
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("Not yet available");
      expect(output).toContain("Codex");
    });

    it("should show missing agent display names in 'Not yet available'", async () => {
      await setManifest(fewMissingManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Not yet available");
      expect(output).toContain("OpenClaw");
      expect(output).toContain("NanoClaw");
      expect(output).toContain("GPTMe");
    });

    it("should NOT show 'Not yet available' when missing agents > 5", async () => {
      await setManifest(manyAgentsManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // 6 missing agents exceeds the <= 5 threshold
      expect(output).not.toContain("Not yet available");
    });

    it("should NOT show 'Not yet available' when all agents are implemented", async () => {
      await setManifest(allImplManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).not.toContain("Not yet available");
    });

    it("should separate multiple missing agent names with commas", async () => {
      await setManifest(fewMissingManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // Find the "Not yet available" line and check for comma separation
      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      const notAvailLine = lines.find((l: string) => l.includes("Not yet available"));
      expect(notAvailLine).toBeDefined();
      expect(notAvailLine!).toContain(", ");
    });
  });

  // ── Setup URL at the bottom ──────────────────────────────────────

  describe("setup URL", () => {
    it("should show setup URL containing the cloud key", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Full setup guide:");
      expect(output).toContain("github.com");
      expect(output).toContain("sprite");
    });

    it("should show setup URL for hetzner", async () => {
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("Full setup guide:");
      expect(output).toContain("hetzner");
    });

    it("should include the REPO constant in the URL", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("OpenRouterTeam/spawn");
    });
  });

  // ── Auth field display ───────────────────────────────────────────

  describe("auth field", () => {
    it("should display auth type in the Type/Auth line", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Auth: token");
    });

    it("should display different auth type", async () => {
      await setManifest(manyAgentsManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Auth: oauth");
    });
  });

  // ── Quick start section ─────────────────────────────────────────

  describe("quick start", () => {
    it("should show Quick start header", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Quick start:");
    });

    it("should show export commands for env var auth", async () => {
      await setManifest(envVarAuthManifest);
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("export HCLOUD_TOKEN=");
    });

    it("should show CLI command for non-env-var auth", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // "token" doesn't match env var pattern, so shown as CLI command
      expect(output).toContain("Quick start:");
      expect(output).toContain("token");
    });

    it("should show example spawn command with first agent", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("spawn claude sprite");
    });
  });

  // ── Agent count display ──────────────────────────────────────────

  describe("agent count", () => {
    it("should show N of M format for available agents", async () => {
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      // hetzner has 1 implemented out of 2 total agents
      expect(output).toContain("1 of 2");
    });

    it("should show all-implemented count", async () => {
      await setManifest(allImplManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("2 of 2");
    });

    it("should show correct count with many agents", async () => {
      await setManifest(manyAgentsManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // 1 implemented out of 7 total
      expect(output).toContain("1 of 7");
    });

    it("should show correct count with few missing", async () => {
      await setManifest(fewMissingManifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // 2 implemented out of 5 total
      expect(output).toContain("2 of 5");
    });
  });

  // ── Cloud URL display ────────────────────────────────────────────

  describe("cloud URL", () => {
    it("should display the cloud URL", async () => {
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("https://sprite.sh");
    });

    it("should display hetzner URL", async () => {
      await cmdCloudInfo("hetzner");
      const output = getOutput();
      expect(output).toContain("https://hetzner.com");
    });
  });
});

describe("cmdAgentInfo - URL and count details", () => {
  let consoleMocks: ReturnType<typeof createConsoleMocks>;
  let originalFetch: typeof global.fetch;
  let savedORKey: string | undefined;

  function setManifest(manifest: any) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
    return loadManifest(true);
  }

  function getOutput(): string {
    return consoleMocks.log.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  beforeEach(async () => {
    consoleMocks = createConsoleMocks();
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();

    savedORKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    originalFetch = global.fetch;
    await setManifest(mockManifest);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    restoreMocks(consoleMocks.log, consoleMocks.error);
    if (savedORKey !== undefined) {
      process.env.OPENROUTER_API_KEY = savedORKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  // ── Agent URL display ────────────────────────────────────────────

  describe("agent URL", () => {
    it("should display the agent URL", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("https://claude.ai");
    });

    it("should display codex URL", async () => {
      await cmdAgentInfo("codex");
      const output = getOutput();
      expect(output).toContain("https://codex.dev");
    });

    it("should display specific URL when agent has custom URL", async () => {
      await setManifest(agentWithUrlManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("https://claude.ai/docs");
    });
  });

  // ── Agent notes display ──────────────────────────────────────────

  describe("agent notes", () => {
    it("should display notes when agent has notes field", async () => {
      await setManifest(agentWithUrlManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Requires Anthropic API key for best results");
    });
  });

  // ── Quick start section ─────────────────────────────────────────

  describe("quick start", () => {
    it("should show Quick start header", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Quick start:");
    });

    it("should show OPENROUTER_API_KEY export", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("export OPENROUTER_API_KEY=");
    });

    it("should show example spawn command with first cloud", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude sprite");
    });

    it("should not show quick start when agent has no implemented clouds", async () => {
      const noImplManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "missing",
          "sprite/codex": "missing",
          "hetzner/claude": "missing",
          "hetzner/codex": "missing",
        },
      };
      await setManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("Quick start:");
    });
  });

  // ── Cloud count display ──────────────────────────────────────────

  describe("cloud count", () => {
    it("should show N of M format for available clouds", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      // claude has 2 implemented out of 2 total clouds
      expect(output).toContain("2 of 2");
    });

    it("should show partial count for codex", async () => {
      await cmdAgentInfo("codex");
      const output = getOutput();
      // codex has 1 implemented out of 2 total clouds
      expect(output).toContain("1 of 2");
    });

    it("should show 0 of N when agent has no implementations", async () => {
      const noImplManifest = {
        ...mockManifest,
        matrix: {
          "sprite/claude": "missing",
          "sprite/codex": "missing",
          "hetzner/claude": "missing",
          "hetzner/codex": "missing",
        },
      };
      await setManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("0 of 2");
    });
  });

  // ── Cloud grouping by type ───────────────────────────────────────

  describe("cloud grouping by type", () => {
    it("should group clouds by their type field", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      // sprite is type "vm", hetzner is type "cloud"
      // Both should appear as group headers
      expect(output).toContain("vm");
      expect(output).toContain("cloud");
    });

    it("should show cloud display name within its type group", async () => {
      await cmdAgentInfo("claude");
      const lines = consoleMocks.log.mock.calls.map((c: any[]) => c.join(" "));
      // Find lines containing cloud names
      const spriteLine = lines.find((l: string) => l.includes("sprite") && l.includes("Sprite"));
      const hetznerLine = lines.find((l: string) => l.includes("hetzner") && l.includes("Hetzner"));
      expect(spriteLine).toBeDefined();
      expect(hetznerLine).toBeDefined();
    });

    it("should show launch command within type group", async () => {
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude sprite");
      expect(output).toContain("spawn claude hetzner");
    });
  });
});
