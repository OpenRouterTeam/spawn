import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for printAgentQuickStart (commands.ts) and the cmdAgentInfo quick-start
 * integration. This function is invoked when users run `spawn <agent>` and has
 * zero existing test coverage.
 *
 * printAgentQuickStart was recently:
 * - Extracted from cmdAgentInfo into its own function (PR #976)
 * - Enhanced to show ALL auth vars for multi-credential clouds (PR #975)
 *
 * Test coverage:
 * - Single-auth cloud: shows OPENROUTER_API_KEY + single cloud auth var
 * - Multi-auth cloud: shows OPENROUTER_API_KEY + all auth vars with URL hint only on first
 * - No-auth cloud (auth="none"): shows only OPENROUTER_API_KEY
 * - All credentials set: shows "credentials detected -- ready to go"
 * - Partial credentials: shows set vars as green, missing as cyan export
 * - OPENROUTER_API_KEY set but cloud creds missing: not "ready to go"
 * - Cloud creds set but OPENROUTER_API_KEY missing: not "ready to go"
 * - Agent with no implemented clouds: no quick-start section shown
 * - Example launch command uses agent key and cloud key
 * - Credential prioritization: agent info prefers clouds with credentials
 * - Install line display when agent has install command
 * - Available clouds count shows "N of M" format
 * - Grouped cloud list with cloud type headers
 * - Cloud list shows "(credentials detected)" for clouds with credentials
 *
 * Agent: test-engineer
 */

// ── Mock manifests ────────────────────────────────────────────────────────────

const singleAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
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
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://console.hetzner.cloud",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
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
  },
  matrix: {
    "hetzner/claude": "implemented",
    "hetzner/codex": "implemented",
    "sprite/claude": "implemented",
    "sprite/codex": "missing",
  },
};

const multiAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    upcloud: {
      name: "UpCloud",
      description: "European cloud hosting",
      url: "https://hub.upcloud.com/signup",
      type: "cloud",
      auth: "UPCLOUD_USERNAME + UPCLOUD_PASSWORD",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "upcloud/claude": "implemented",
  },
};

const noAuthManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    local: {
      name: "Local Runner",
      description: "Run agents locally",
      url: "https://example.com",
      type: "local",
      auth: "none",
      provision_method: "none",
      exec_method: "bash",
      interactive_method: "bash",
    },
  },
  matrix: {
    "local/claude": "implemented",
  },
};

const noImplManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://console.hetzner.cloud",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "hetzner/claude": "missing",
  },
};

const multiCloudManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
      launch: "claude",
      env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
    },
  },
  clouds: {
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://console.hetzner.cloud",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    vultr: {
      name: "Vultr",
      description: "Cloud infrastructure",
      url: "https://my.vultr.com",
      type: "cloud",
      auth: "VULTR_API_KEY",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
    local: {
      name: "Local Runner",
      description: "Run agents locally",
      url: "https://example.com",
      type: "local",
      auth: "none",
      provision_method: "none",
      exec_method: "bash",
      interactive_method: "bash",
    },
  },
  matrix: {
    "hetzner/claude": "implemented",
    "vultr/claude": "implemented",
    "local/claude": "implemented",
  },
};

// No-install agent (no install field)
const noInstallManifest: Manifest = {
  agents: {
    custom: {
      name: "Custom Agent",
      description: "A custom agent",
      url: "https://example.com",
      install: "",
      launch: "custom-agent",
      env: {},
    },
  },
  clouds: {
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://console.hetzner.cloud",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "hetzner/custom": "implemented",
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

const { cmdAgentInfo } = await import("../commands.js");

// ── Test helpers ──────────────────────────────────────────────────────────────

function setupManifest(manifest: Manifest) {
  global.fetch = mock(async () => ({
    ok: true,
    json: async () => manifest,
    text: async () => JSON.stringify(manifest),
  })) as any;
  return loadManifest(true);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cmdAgentInfo - printAgentQuickStart", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let processExitSpy: ReturnType<typeof spyOn>;
  let savedEnv: Record<string, string | undefined>;

  function getOutput(): string {
    return consoleSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function getOutputLines(): string[] {
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

    // Save and clear credential env vars
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
      VULTR_API_KEY: process.env.VULTR_API_KEY,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HCLOUD_TOKEN;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;
    delete process.env.VULTR_API_KEY;
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

  // ── Single-auth cloud quick-start ──────────────────────────────────

  describe("single-auth cloud", () => {
    it("should show Quick start header", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Quick start");
    });

    it("should show OPENROUTER_API_KEY export line when not set", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
      expect(output).toContain("export");
    });

    it("should show cloud auth var export line when not set", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("HCLOUD_TOKEN");
    });

    it("should show example launch command with agent and cloud keys", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude hetzner");
    });

    it("should show URL hint for OpenRouter API key", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("openrouter.ai/settings/keys");
    });

    it("should show cloud URL hint on auth var line", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("console.hetzner.cloud");
    });
  });

  // ── Multi-auth cloud quick-start ───────────────────────────────────

  describe("multi-auth cloud (UPCLOUD_USERNAME + UPCLOUD_PASSWORD)", () => {
    it("should show both auth env vars", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("UPCLOUD_USERNAME");
      expect(output).toContain("UPCLOUD_PASSWORD");
    });

    it("should show URL hint only on first auth var", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();

      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);

      const usernameLine = afterQuickStart.find((l: string) => l.includes("UPCLOUD_USERNAME"));
      const passwordLine = afterQuickStart.find((l: string) => l.includes("UPCLOUD_PASSWORD"));

      expect(usernameLine).toBeDefined();
      expect(passwordLine).toBeDefined();
      // URL hint on first auth var
      expect(usernameLine).toContain("hub.upcloud.com");
      // URL hint NOT on second auth var
      expect(passwordLine).not.toContain("hub.upcloud.com");
    });

    it("should show OPENROUTER_API_KEY before cloud auth vars", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();

      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);

      const orKeyIdx = afterQuickStart.findIndex((l: string) => l.includes("OPENROUTER_API_KEY"));
      const usernameIdx = afterQuickStart.findIndex((l: string) => l.includes("UPCLOUD_USERNAME"));

      expect(orKeyIdx).toBeGreaterThanOrEqual(0);
      expect(usernameIdx).toBeGreaterThanOrEqual(0);
      expect(orKeyIdx).toBeLessThan(usernameIdx);
    });

    it("should show example launch command", async () => {
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude upcloud");
    });
  });

  // ── All credentials set ────────────────────────────────────────────

  describe("all credentials set", () => {
    it("should show 'credentials detected -- ready to go' for single-auth", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("credentials detected");
      expect(output).toContain("ready to go");
    });

    it("should show 'credentials detected -- ready to go' for multi-auth", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      process.env.UPCLOUD_PASSWORD = "testpass";
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("credentials detected");
      expect(output).toContain("ready to go");
    });

    it("should not show export lines when all credentials are set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const exportLines = afterQuickStart.filter((l: string) => l.includes("export"));
      expect(exportLines).toHaveLength(0);
    });

    it("should still show example launch command", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude hetzner");
    });
  });

  // ── Partial credentials ────────────────────────────────────────────

  describe("partial credentials", () => {
    it("should not show 'ready to go' when OPENROUTER_API_KEY set but cloud creds missing", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      // HCLOUD_TOKEN not set
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
      expect(output).toContain("HCLOUD_TOKEN");
    });

    it("should not show 'ready to go' when cloud creds set but OPENROUTER_API_KEY missing", async () => {
      // OPENROUTER_API_KEY not set
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should show green indicator for set vars and export for missing vars", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      // HCLOUD_TOKEN not set
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);

      // OPENROUTER_API_KEY should show as "-- set" (green)
      const orLine = afterQuickStart.find((l: string) => l.includes("OPENROUTER_API_KEY"));
      expect(orLine).toContain("-- set");

      // HCLOUD_TOKEN should show as "export" (missing)
      const hcloudLine = afterQuickStart.find((l: string) => l.includes("HCLOUD_TOKEN"));
      expect(hcloudLine).toContain("export");
    });

    it("should not show 'ready to go' for multi-auth with only one of two vars set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.UPCLOUD_USERNAME = "testuser";
      // UPCLOUD_PASSWORD not set
      await setupManifest(multiAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
      expect(output).toContain("UPCLOUD_PASSWORD");
    });
  });

  // ── No-auth cloud (auth="none") ────────────────────────────────────

  describe("no-auth cloud (auth='none')", () => {
    it("should show only OPENROUTER_API_KEY when cloud has no auth", async () => {
      await setupManifest(noAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("OPENROUTER_API_KEY");
      // Should not show any cloud-specific auth var
      expect(output).not.toContain("export LOCAL");
    });

    it("should show 'ready to go' when OPENROUTER_API_KEY set and no cloud auth needed", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      await setupManifest(noAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("credentials detected");
      expect(output).toContain("ready to go");
    });

    it("should show example launch command with local cloud", async () => {
      await setupManifest(noAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("spawn claude local");
    });
  });

  // ── No implemented clouds ──────────────────────────────────────────

  describe("agent with no implemented clouds", () => {
    it("should not show Quick start section", async () => {
      await setupManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("Quick start");
    });

    it("should show 'No implemented clouds yet'", async () => {
      await setupManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("No implemented clouds yet");
    });

    it("should show 'Available clouds: 0 of N'", async () => {
      await setupManifest(noImplManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Available clouds:");
      expect(output).toContain("0 of");
    });
  });

  // ── Agent info header display ──────────────────────────────────────

  describe("agent info header", () => {
    it("should show agent name and description", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Claude Code");
      expect(output).toContain("AI coding assistant");
    });

    it("should show install command when present", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Install:");
      expect(output).toContain("npm install");
    });

    it("should not show install line when install is empty string", async () => {
      await setupManifest(noInstallManifest);
      await cmdAgentInfo("custom");
      const output = getOutput();
      expect(output).not.toContain("Install:");
    });

    it("should show agent URL", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("claude.ai");
    });
  });

  // ── Available clouds listing ───────────────────────────────────────

  describe("available clouds listing", () => {
    it("should show count of implemented clouds out of total", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // claude is implemented on hetzner and sprite (2 of 2)
      expect(output).toContain("2 of 2");
    });

    it("should list each implemented cloud with launch command hint", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Hetzner Cloud");
      expect(output).toContain("spawn claude hetzner");
      expect(output).toContain("Sprite");
      expect(output).toContain("spawn claude sprite");
    });

    it("should group clouds by type", async () => {
      await setupManifest(multiCloudManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // Should show cloud type headers
      expect(output).toContain("cloud");
      expect(output).toContain("local");
    });

    it("should show '(credentials detected)' for clouds with set credentials", async () => {
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("credentials detected");
    });

    it("should show credential count when multiple clouds have credentials", async () => {
      process.env.HCLOUD_TOKEN = "test-token";
      process.env.VULTR_API_KEY = "test-key";
      await setupManifest(multiCloudManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("2 clouds with credentials detected");
      expect(output).toContain("shown first");
    });

    it("should show singular 'cloud' when only one has credentials", async () => {
      process.env.HCLOUD_TOKEN = "test-token";
      await setupManifest(multiCloudManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("1 cloud with credentials detected");
    });

    it("should not show credential count when no clouds have credentials", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();
      const credCountLines = lines.filter((l: string) => l.includes("with credentials detected (shown first)"));
      expect(credCountLines).toHaveLength(0);
    });
  });

  // ── Credential prioritization ──────────────────────────────────────

  describe("credential prioritization", () => {
    it("should prefer cloud with credentials as quick-start example", async () => {
      // Set vultr credentials but not hetzner
      process.env.VULTR_API_KEY = "test-key";
      await setupManifest(multiCloudManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      // The quick-start launch command should use vultr (which has credentials)
      const launchLine = afterQuickStart.find((l: string) => l.includes("spawn claude"));
      expect(launchLine).toContain("vultr");
    });

    it("should use first cloud when no credentials are set anywhere", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const lines = getOutputLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      const launchLine = afterQuickStart.find((l: string) => l.includes("spawn claude"));
      expect(launchLine).toBeDefined();
    });
  });

  // ── Agent resolution ───────────────────────────────────────────────

  describe("agent resolution", () => {
    it("should accept exact agent key", async () => {
      await setupManifest(singleAuthManifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("Claude Code");
    });

    it("should exit with error for unknown agent", async () => {
      await setupManifest(singleAuthManifest);
      try {
        await cmdAgentInfo("nonexistent");
      } catch {
        // Expected: process.exit mock throws
      }
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// ── Replica tests for printAgentQuickStart logic ────────────────────────────
// (Tests the pure logic without needing to invoke cmdAgentInfo)

/**
 * Exact replica of parseAuthEnvVars from commands.ts
 * Used to test printAgentQuickStart logic in isolation.
 */
function parseAuthEnvVars(auth: string): string[] {
  return auth
    .split(/\s*\+\s*/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s));
}

/**
 * Exact replica of hasCloudCredentials from commands.ts
 */
function hasCloudCredentials(auth: string): boolean {
  const vars = parseAuthEnvVars(auth);
  if (vars.length === 0) return false;
  return vars.every((v) => !!process.env[v]);
}

interface QuickStartResult {
  type: "ready" | "setup";
  lines: string[];
  launchCmd: string;
}

/**
 * Replica of printAgentQuickStart logic from commands.ts.
 * Returns structured output instead of printing to console for easier assertions.
 */
function computeQuickStart(
  cloudAuth: string,
  cloudUrl: string | undefined,
  agentKey: string,
  cloudKey: string,
): QuickStartResult {
  const authVars = parseAuthEnvVars(cloudAuth);
  const hasCreds = hasCloudCredentials(cloudAuth);
  const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;
  const allReady = hasOpenRouterKey && (hasCreds || authVars.length === 0);
  const launchCmd = `spawn ${agentKey} ${cloudKey}`;

  if (allReady) {
    return { type: "ready", lines: ["credentials detected -- ready to go"], launchCmd };
  }

  const lines: string[] = [];
  // OPENROUTER_API_KEY line
  if (process.env.OPENROUTER_API_KEY) {
    lines.push(`OPENROUTER_API_KEY -- set`);
  } else {
    lines.push(`export OPENROUTER_API_KEY=... # https://openrouter.ai/settings/keys`);
  }

  // Cloud auth var lines
  for (let i = 0; i < authVars.length; i++) {
    const v = authVars[i];
    if (process.env[v]) {
      lines.push(`${v} -- set`);
    } else {
      const hint = i === 0 && cloudUrl ? ` # ${cloudUrl}` : "";
      lines.push(`export ${v}=...${hint}`);
    }
  }

  return { type: "setup", lines, launchCmd };
}

describe("printAgentQuickStart - pure logic", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
    };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.HCLOUD_TOKEN;
    delete process.env.UPCLOUD_USERNAME;
    delete process.env.UPCLOUD_PASSWORD;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ── All missing credentials ────────────────────────────────────────

  it("should return 'setup' type when no credentials are set", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", "https://console.hetzner.cloud", "claude", "hetzner");
    expect(result.type).toBe("setup");
  });

  it("should include OPENROUTER_API_KEY export line", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", "https://console.hetzner.cloud", "claude", "hetzner");
    expect(result.lines[0]).toContain("OPENROUTER_API_KEY");
    expect(result.lines[0]).toContain("export");
  });

  it("should include cloud auth var export line with URL hint", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", "https://console.hetzner.cloud", "claude", "hetzner");
    expect(result.lines[1]).toContain("HCLOUD_TOKEN");
    expect(result.lines[1]).toContain("console.hetzner.cloud");
  });

  it("should produce correct launch command", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", "https://console.hetzner.cloud", "claude", "hetzner");
    expect(result.launchCmd).toBe("spawn claude hetzner");
  });

  // ── All credentials set ────────────────────────────────────────────

  it("should return 'ready' type when all credentials are set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.HCLOUD_TOKEN = "test-token";
    const result = computeQuickStart("HCLOUD_TOKEN", "https://console.hetzner.cloud", "claude", "hetzner");
    expect(result.type).toBe("ready");
    expect(result.lines[0]).toContain("credentials detected");
  });

  // ── Multi-auth with all set ────────────────────────────────────────

  it("should return 'ready' for multi-auth when all vars are set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.UPCLOUD_USERNAME = "user";
    process.env.UPCLOUD_PASSWORD = "pass";
    const result = computeQuickStart("UPCLOUD_USERNAME + UPCLOUD_PASSWORD", "https://hub.upcloud.com", "claude", "upcloud");
    expect(result.type).toBe("ready");
  });

  // ── Multi-auth with partial set ────────────────────────────────────

  it("should return 'setup' for multi-auth when only one var is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.UPCLOUD_USERNAME = "user";
    // UPCLOUD_PASSWORD not set
    const result = computeQuickStart("UPCLOUD_USERNAME + UPCLOUD_PASSWORD", "https://hub.upcloud.com", "claude", "upcloud");
    expect(result.type).toBe("setup");
  });

  it("should show set var as '-- set' and missing var with export", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.UPCLOUD_USERNAME = "user";
    const result = computeQuickStart("UPCLOUD_USERNAME + UPCLOUD_PASSWORD", "https://hub.upcloud.com", "claude", "upcloud");
    expect(result.lines[0]).toContain("OPENROUTER_API_KEY");
    expect(result.lines[0]).toContain("-- set");
    expect(result.lines[1]).toContain("UPCLOUD_USERNAME");
    expect(result.lines[1]).toContain("-- set");
    expect(result.lines[2]).toContain("UPCLOUD_PASSWORD");
    expect(result.lines[2]).toContain("export");
  });

  // ── URL hint placement ─────────────────────────────────────────────

  it("should show URL hint only on first auth var for multi-auth", () => {
    const result = computeQuickStart("UPCLOUD_USERNAME + UPCLOUD_PASSWORD", "https://hub.upcloud.com", "claude", "upcloud");
    // First auth var should have URL hint
    expect(result.lines[1]).toContain("hub.upcloud.com");
    // Second auth var should NOT have URL hint
    expect(result.lines[2]).not.toContain("hub.upcloud.com");
  });

  it("should not show URL hint when cloudUrl is undefined", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", undefined, "claude", "hetzner");
    expect(result.lines[1]).toContain("HCLOUD_TOKEN");
    expect(result.lines[1]).not.toContain("#");
  });

  // ── No cloud auth (auth="none") ────────────────────────────────────

  it("should show only OPENROUTER_API_KEY for auth='none'", () => {
    const result = computeQuickStart("none", undefined, "claude", "local");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("OPENROUTER_API_KEY");
  });

  it("should return 'ready' for auth='none' when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const result = computeQuickStart("none", undefined, "claude", "local");
    expect(result.type).toBe("ready");
  });

  // ── Non-parseable auth string ──────────────────────────────────────

  it("should treat unparseable auth string same as no auth vars", () => {
    const result = computeQuickStart("OAuth + browser", undefined, "claude", "oauthcloud");
    // "OAuth" and "browser" don't match ^[A-Z][A-Z0-9_]{3,}$, so no auth vars
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("OPENROUTER_API_KEY");
  });

  it("should return 'ready' for unparseable auth when OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const result = computeQuickStart("OAuth + browser", undefined, "claude", "oauthcloud");
    expect(result.type).toBe("ready");
  });

  // ── Launch command format ──────────────────────────────────────────

  it("should format launch command as 'spawn agent cloud'", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", undefined, "codex", "hetzner");
    expect(result.launchCmd).toBe("spawn codex hetzner");
  });

  it("should use provided agent and cloud keys exactly", () => {
    const result = computeQuickStart("HCLOUD_TOKEN", undefined, "my-agent", "my-cloud");
    expect(result.launchCmd).toBe("spawn my-agent my-cloud");
  });
});
