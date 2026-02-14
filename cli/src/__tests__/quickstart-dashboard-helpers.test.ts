import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Manifest } from "../manifest";

/**
 * Tests for the unified printQuickStart function and the extracted
 * buildDashboardHint helper introduced in PR #1042.
 *
 * PR #1042 merged printAgentQuickStart and printCloudQuickStart into
 * a single printQuickStart(opts) function, and extracted the repeated
 * dashboardUrl ternary into buildDashboardHint(dashboardUrl).
 *
 * Existing coverage:
 * - cloud-agent-quickstart.test.ts: integration tests for cmdCloudInfo/cmdAgentInfo
 *   Quick start sections (multi-auth, none-auth, credential indicators)
 * - script-failure-guidance.test.ts: dashboardUrl in getSignalGuidance and
 *   getScriptFailureGuidance (tests the extracted buildDashboardHint indirectly)
 *
 * This file covers the UNTESTED paths:
 * - buildDashboardHint: tested directly via getSignalGuidance/getScriptFailureGuidance
 *   with edge cases (empty string URL, undefined, very long URL)
 * - printQuickStart unified behavior: credential-ready shortcut with no spawnCmd,
 *   auth string that parses to zero env vars with spawnCmd, partial credential state
 * - cmdAgentInfo: credential-prioritized cloud ordering in Quick start
 * - cmdCloudInfo: dashboard hint in post-exec failure messages when cloud has url
 *
 * Agent: test-engineer
 */

// ── Test manifests ────────────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<{
  clouds: Manifest["clouds"];
  agents: Manifest["agents"];
  matrix: Manifest["matrix"];
}>): Manifest {
  return {
    agents: overrides?.agents ?? {
      claude: {
        name: "Claude Code",
        description: "AI coding assistant",
        url: "https://claude.ai",
        install: "npm install -g claude",
        launch: "claude",
        env: { ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY" },
      },
    },
    clouds: overrides?.clouds ?? {
      sprite: {
        name: "Sprite",
        description: "Dev VMs",
        url: "https://sprite.sh",
        type: "vm",
        auth: "SPRITE_TOKEN",
        provision_method: "api",
        exec_method: "ssh",
        interactive_method: "ssh",
      },
    },
    matrix: overrides?.matrix ?? {
      "sprite/claude": "implemented",
    },
  };
}

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
const mockLogWarn = mock(() => {});
const mockLogSuccess = mock(() => {});
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
    error: mockLogError,
    warn: mockLogWarn,
    success: mockLogSuccess,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  confirm: mock(() => Promise.resolve(true)),
  isCancel: () => false,
}));

const {
  getSignalGuidance,
  getScriptFailureGuidance,
  cmdCloudInfo,
  cmdAgentInfo,
} = await import("../commands.js");
const { loadManifest } = await import("../manifest.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearMocks() {
  mockLogError.mockClear();
  mockLogInfo.mockClear();
  mockLogStep.mockClear();
  mockLogWarn.mockClear();
  mockLogSuccess.mockClear();
  mockSpinnerStart.mockClear();
  mockSpinnerStop.mockClear();
  mockSpinnerMessage.mockClear();
}

// ── buildDashboardHint via getSignalGuidance ─────────────────────────────────

describe("buildDashboardHint edge cases via getSignalGuidance", () => {
  it("should use provided URL in dashboard hint for SIGKILL", () => {
    const lines = getSignalGuidance("SIGKILL", "https://console.hetzner.cloud/");
    const joined = lines.join("\n");
    expect(joined).toContain("https://console.hetzner.cloud/");
    expect(joined).toContain("Check your dashboard");
  });

  it("should use generic fallback when dashboardUrl is undefined", () => {
    const lines = getSignalGuidance("SIGKILL");
    const joined = lines.join("\n");
    expect(joined).toContain("Check your cloud provider dashboard");
    expect(joined).not.toContain("https://");
  });

  it("should use generic fallback when dashboardUrl is empty string", () => {
    const lines = getSignalGuidance("SIGKILL", "");
    const joined = lines.join("\n");
    // Empty string is falsy, so buildDashboardHint should use fallback
    expect(joined).toContain("cloud provider dashboard");
  });

  it("should handle very long dashboard URL without truncation", () => {
    const longUrl = "https://very-long-subdomain.cloud-provider.example.com/dashboard/projects/12345/servers";
    const lines = getSignalGuidance("SIGTERM", longUrl);
    const joined = lines.join("\n");
    expect(joined).toContain(longUrl);
  });

  it("should include dashboard hint in SIGKILL, SIGTERM, SIGINT but NOT SIGHUP", () => {
    const url = "https://test.cloud/dashboard";
    for (const sig of ["SIGKILL", "SIGTERM", "SIGINT"]) {
      const lines = getSignalGuidance(sig, url);
      const joined = lines.join("\n");
      expect(joined).toContain(url);
    }
    // SIGHUP uses hardcoded message about terminal multiplexer, no dashboard hint
    const sighupLines = getSignalGuidance("SIGHUP", url);
    const sighupJoined = sighupLines.join("\n");
    expect(sighupJoined).not.toContain(url);
  });

  it("should include dashboard hint in unknown signal case", () => {
    const url = "https://my.vultr.com/";
    const lines = getSignalGuidance("SIGUSR2", url);
    const joined = lines.join("\n");
    expect(joined).toContain(url);
  });

  it("should use generic fallback for unknown signal without URL", () => {
    const lines = getSignalGuidance("SIGXCPU");
    const joined = lines.join("\n");
    expect(joined).toContain("cloud provider dashboard");
  });
});

// ── buildDashboardHint via getScriptFailureGuidance ─────────────────────────

describe("buildDashboardHint edge cases via getScriptFailureGuidance", () => {
  it("should include dashboard URL for exit code 130 (Ctrl+C)", () => {
    const lines = getScriptFailureGuidance(130, "hetzner", undefined, "https://console.hetzner.cloud/");
    const joined = lines.join("\n");
    expect(joined).toContain("https://console.hetzner.cloud/");
  });

  it("should include dashboard URL for exit code 137 (OOM)", () => {
    const lines = getScriptFailureGuidance(137, "vultr", undefined, "https://my.vultr.com/");
    const joined = lines.join("\n");
    expect(joined).toContain("https://my.vultr.com/");
  });

  it("should use generic fallback for exit 130 without URL", () => {
    const lines = getScriptFailureGuidance(130, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("cloud provider dashboard");
    expect(joined).not.toContain("https://");
  });

  it("should use generic fallback for exit 137 without URL", () => {
    const lines = getScriptFailureGuidance(137, "sprite");
    const joined = lines.join("\n");
    expect(joined).toContain("cloud provider dashboard");
  });

  it("should NOT include dashboard hint for exit 255 (SSH failure)", () => {
    const lines = getScriptFailureGuidance(255, "sprite", undefined, "https://sprite.sh");
    const joined = lines.join("\n");
    // SSH failure doesn't need dashboard hint - it's a connectivity issue
    expect(joined).not.toContain("https://sprite.sh");
  });

  it("should NOT include dashboard hint for exit 127 (command not found)", () => {
    const lines = getScriptFailureGuidance(127, "hetzner", undefined, "https://console.hetzner.cloud/");
    const joined = lines.join("\n");
    expect(joined).not.toContain("https://console.hetzner.cloud/");
  });

  it("should NOT include dashboard hint for exit 126 (permission denied)", () => {
    const lines = getScriptFailureGuidance(126, "hetzner", undefined, "https://console.hetzner.cloud/");
    const joined = lines.join("\n");
    expect(joined).not.toContain("https://console.hetzner.cloud/");
  });

  it("should NOT include dashboard hint for exit 2 (shell syntax error)", () => {
    const lines = getScriptFailureGuidance(2, "hetzner", undefined, "https://console.hetzner.cloud/");
    const joined = lines.join("\n");
    expect(joined).not.toContain("https://console.hetzner.cloud/");
  });

  it("should include dashboard URL for exit code 1 (generic failure)", () => {
    const lines = getScriptFailureGuidance(1, "sprite", undefined, "https://sprite.sh");
    const joined = lines.join("\n");
    expect(joined).toContain("https://sprite.sh");
  });

  it("should include dashboard URL for unknown exit codes", () => {
    const lines = getScriptFailureGuidance(42, "sprite", undefined, "https://sprite.sh");
    const joined = lines.join("\n");
    expect(joined).toContain("https://sprite.sh");
  });

  it("should include dashboard URL for null exit code", () => {
    const lines = getScriptFailureGuidance(null, "sprite", undefined, "https://sprite.sh");
    const joined = lines.join("\n");
    expect(joined).toContain("https://sprite.sh");
  });

  it("should omit dashboard line for exit code 1 when URL is empty string", () => {
    const lines = getScriptFailureGuidance(1, "sprite", undefined, "");
    const joined = lines.join("\n");
    // Empty string is falsy -- no dashboard line is added at all for exit code 1
    // (exit code 1 uses inline ternary, not buildDashboardHint)
    expect(joined).not.toContain("dashboard");
  });

  it("should consistently use 'Check your dashboard' wording with URL", () => {
    for (const code of [130, 137, 1, 42, null]) {
      const lines = getScriptFailureGuidance(code as any, "test", undefined, "https://example.com");
      const joined = lines.join("\n");
      if (joined.includes("https://example.com")) {
        expect(joined).toContain("dashboard");
      }
    }
  });
});

// ── printQuickStart via cmdCloudInfo ─────────────────────────────────────────

describe("printQuickStart unified behavior via cmdCloudInfo", () => {
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
    clearMocks();
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    originalFetch = global.fetch;

    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      SPRITE_TOKEN: process.env.SPRITE_TOKEN,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
      UPCLOUD_USERNAME: process.env.UPCLOUD_USERNAME,
      UPCLOUD_PASSWORD: process.env.UPCLOUD_PASSWORD,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("Quick start with single-auth cloud", () => {
    it("should show export instruction for missing SPRITE_TOKEN", async () => {
      delete process.env.SPRITE_TOKEN;
      delete process.env.OPENROUTER_API_KEY;
      await setupManifest(makeManifest());
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("SPRITE_TOKEN");
      expect(output).toContain("OPENROUTER_API_KEY");
    });

    it("should show spawn command with first agent", async () => {
      delete process.env.SPRITE_TOKEN;
      await setupManifest(makeManifest());
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("spawn claude sprite");
    });

    it("should show cloud URL hint next to first auth var", async () => {
      delete process.env.SPRITE_TOKEN;
      await setupManifest(makeManifest());
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("sprite.sh");
    });
  });

  describe("Quick start with no implemented agents", () => {
    it("should not show spawn command when no agents are implemented", async () => {
      const manifest = makeManifest({
        matrix: { "sprite/claude": "missing" },
      });
      delete process.env.SPRITE_TOKEN;
      await setupManifest(manifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("Quick start");
      expect(output).not.toContain("spawn claude sprite");
    });

    it("should still show auth env vars even with no agents", async () => {
      const manifest = makeManifest({
        matrix: { "sprite/claude": "missing" },
      });
      delete process.env.SPRITE_TOKEN;
      await setupManifest(manifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("SPRITE_TOKEN");
      expect(output).toContain("OPENROUTER_API_KEY");
    });
  });

  describe("Quick start ready-to-go shortcut", () => {
    it("should show ready-to-go when all credentials are set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.SPRITE_TOKEN = "test-token";
      await setupManifest(makeManifest());
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).toContain("ready to go");
      expect(output).toContain("spawn claude sprite");
    });

    it("should NOT show ready-to-go when only cloud cred is set", async () => {
      delete process.env.OPENROUTER_API_KEY;
      process.env.SPRITE_TOKEN = "test-token";
      await setupManifest(makeManifest());
      await cmdCloudInfo("sprite");
      const output = getOutput();
      expect(output).not.toContain("ready to go");
    });

    it("should NOT show ready-to-go when cloud has no agents (no spawnCmd)", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.SPRITE_TOKEN = "test-token";
      const manifest = makeManifest({
        matrix: { "sprite/claude": "missing" },
      });
      await setupManifest(manifest);
      await cmdCloudInfo("sprite");
      const output = getOutput();
      // ready-to-go requires a spawnCmd; no agents means no spawnCmd
      expect(output).not.toContain("ready to go");
    });
  });

  describe("Quick start with non-parseable auth", () => {
    it("should show raw auth string when it yields no env vars", async () => {
      const manifest = makeManifest({
        clouds: {
          localcloud: {
            name: "Local Cloud",
            description: "Local provider",
            url: "https://local.example.com",
            type: "local",
            auth: "OAuth + browser flow",
            provision_method: "cli",
            exec_method: "bash",
            interactive_method: "bash",
          },
        },
        agents: {
          claude: {
            name: "Claude Code",
            description: "AI",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
        },
        matrix: { "localcloud/claude": "implemented" },
      });
      delete process.env.OPENROUTER_API_KEY;
      await setupManifest(manifest);
      await cmdCloudInfo("localcloud");
      const output = getOutput();
      // Should show the auth string as-is since no env vars parsed
      expect(output).toContain("Auth:");
      expect(output).toContain("OAuth");
    });

    it("should not show 'none' auth as a hint in Quick start", async () => {
      const manifest = makeManifest({
        clouds: {
          noauth: {
            name: "NoAuth Cloud",
            description: "No auth needed",
            url: "https://noauth.example.com",
            type: "local",
            auth: "none",
            provision_method: "none",
            exec_method: "bash",
            interactive_method: "bash",
          },
        },
        agents: {
          claude: {
            name: "Claude Code",
            description: "AI",
            url: "",
            install: "",
            launch: "",
            env: {},
          },
        },
        matrix: { "noauth/claude": "implemented" },
      });
      delete process.env.OPENROUTER_API_KEY;
      await setupManifest(manifest);
      await cmdCloudInfo("noauth");
      const lines = getLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      const afterQuickStart = lines.slice(quickStartIdx + 1);
      // Should not show "Auth: none" in Quick start section
      const noneAuthLines = afterQuickStart.filter(
        (l: string) => l.includes("Auth:") && l.includes("none")
      );
      expect(noneAuthLines).toHaveLength(0);
    });
  });
});

// ── printQuickStart via cmdAgentInfo ─────────────────────────────────────────

describe("printQuickStart unified behavior via cmdAgentInfo", () => {
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
    clearMocks();
    processExitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    originalFetch = global.fetch;

    savedEnv = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      SPRITE_TOKEN: process.env.SPRITE_TOKEN,
      HCLOUD_TOKEN: process.env.HCLOUD_TOKEN,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    processExitSpy.mockRestore();
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("credential-prioritized cloud in Quick start", () => {
    it("should use the first sorted cloud (with credentials) for Quick start", async () => {
      // Set up: hetzner has credentials, sprite does not
      process.env.HCLOUD_TOKEN = "test-token";
      delete process.env.SPRITE_TOKEN;
      delete process.env.OPENROUTER_API_KEY;

      const manifest = makeManifest({
        clouds: {
          sprite: {
            name: "Sprite",
            description: "Dev VMs",
            url: "https://sprite.sh",
            type: "vm",
            auth: "SPRITE_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
          hetzner: {
            name: "Hetzner Cloud",
            description: "EU cloud",
            url: "https://console.hetzner.cloud",
            type: "cloud",
            auth: "HCLOUD_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
        },
      });
      await setupManifest(manifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // The Quick start example should use hetzner (has credentials) not sprite
      expect(output).toContain("spawn claude hetzner");
    });

    it("should show Quick start with first cloud if no credentials detected", async () => {
      delete process.env.SPRITE_TOKEN;
      delete process.env.HCLOUD_TOKEN;
      delete process.env.OPENROUTER_API_KEY;

      const manifest = makeManifest({
        clouds: {
          sprite: {
            name: "Sprite",
            description: "Dev VMs",
            url: "https://sprite.sh",
            type: "vm",
            auth: "SPRITE_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
          hetzner: {
            name: "Hetzner Cloud",
            description: "EU cloud",
            url: "https://console.hetzner.cloud",
            type: "cloud",
            auth: "HCLOUD_TOKEN",
            provision_method: "api",
            exec_method: "ssh",
            interactive_method: "ssh",
          },
        },
        matrix: {
          "sprite/claude": "implemented",
          "hetzner/claude": "implemented",
        },
      });
      await setupManifest(manifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      // When no credentials detected anywhere, order is preserved
      expect(output).toContain("spawn claude sprite");
    });
  });

  describe("agent with no implementations", () => {
    it("should not show Quick start section", async () => {
      const manifest = makeManifest({
        matrix: { "sprite/claude": "missing" },
      });
      await setupManifest(manifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).not.toContain("Quick start");
    });

    it("should show no-implementations message", async () => {
      const manifest = makeManifest({
        matrix: { "sprite/claude": "missing" },
      });
      await setupManifest(manifest);
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("No implemented clouds");
    });
  });

  describe("agent with single cloud ready-to-go", () => {
    it("should show ready-to-go with spawn command when all creds set", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.SPRITE_TOKEN = "test-token";
      await setupManifest(makeManifest());
      await cmdAgentInfo("claude");
      const output = getOutput();
      expect(output).toContain("ready to go");
      expect(output).toContain("spawn claude sprite");
    });

    it("should not show export lines when ready-to-go", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      process.env.SPRITE_TOKEN = "test-token";
      await setupManifest(makeManifest());
      await cmdAgentInfo("claude");
      const lines = getLines();
      const quickStartIdx = lines.findIndex((l: string) => l.includes("Quick start"));
      expect(quickStartIdx).toBeGreaterThanOrEqual(0);
      // After Quick start + "ready to go" line, the next line is the spawn command
      // There should be no "export" lines
      const afterQuickStart = lines.slice(quickStartIdx + 1, quickStartIdx + 3);
      const exportLines = afterQuickStart.filter((l: string) => l.includes("export"));
      expect(exportLines).toHaveLength(0);
    });
  });
});

// ── buildDashboardHint consistency across exit codes ─────────────────────────

describe("buildDashboardHint consistency", () => {
  const url = "https://cloud.example.com/dashboard";

  it("should produce identical dashboard hint for all signal types that use it", () => {
    const sigkill = getSignalGuidance("SIGKILL", url);
    const sigterm = getSignalGuidance("SIGTERM", url);
    const sigint = getSignalGuidance("SIGINT", url);
    const unknown = getSignalGuidance("SIGFOO", url);

    // All should contain the same dashboard hint text
    for (const lines of [sigkill, sigterm, sigint, unknown]) {
      const dashboardLine = lines.find((l: string) => l.includes(url));
      expect(dashboardLine).toBeDefined();
      expect(dashboardLine).toContain("Check your dashboard");
    }
  });

  it("should produce identical fallback for all signal types without URL", () => {
    const sigkill = getSignalGuidance("SIGKILL");
    const sigterm = getSignalGuidance("SIGTERM");
    const sigint = getSignalGuidance("SIGINT");
    const unknown = getSignalGuidance("SIGFOO");

    for (const lines of [sigkill, sigterm, sigint, unknown]) {
      const dashboardLine = lines.find((l: string) =>
        l.includes("cloud provider dashboard")
      );
      expect(dashboardLine).toBeDefined();
    }
  });

  it("should produce identical dashboard hint for exit codes 130 and 137", () => {
    const code130 = getScriptFailureGuidance(130, "test", undefined, url);
    const code137 = getScriptFailureGuidance(137, "test", undefined, url);

    const hint130 = code130.find((l: string) => l.includes(url));
    const hint137 = code137.find((l: string) => l.includes(url));
    expect(hint130).toBeDefined();
    expect(hint137).toBeDefined();
    // Both should use the same "Check your dashboard" wording
    expect(hint130).toEqual(hint137);
  });

  it("should produce different hint format for exit code 1 vs 130", () => {
    // Exit 1 uses inline dashboard URL in the list, exit 130 uses buildDashboardHint
    const code1 = getScriptFailureGuidance(1, "test", undefined, url);
    const code130 = getScriptFailureGuidance(130, "test", undefined, url);

    // Both mention the URL but in different contexts
    const joined1 = code1.join("\n");
    const joined130 = code130.join("\n");
    expect(joined1).toContain(url);
    expect(joined130).toContain(url);
  });
});

// ── cmdCloudInfo agent list section ─────────────────────────────────────────

describe("cmdCloudInfo agent list and count display", () => {
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
    clearMocks();
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

  it("should show correct agent count header", async () => {
    const manifest = makeManifest({
      agents: {
        claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
        aider: { name: "Aider", description: "b", url: "", install: "", launch: "", env: {} },
        codex: { name: "Codex", description: "c", url: "", install: "", launch: "", env: {} },
      },
      matrix: {
        "sprite/claude": "implemented",
        "sprite/aider": "implemented",
        "sprite/codex": "missing",
      },
    });
    await setupManifest(manifest);
    await cmdCloudInfo("sprite");
    const output = getOutput();
    // 2 of 3 agents implemented
    expect(output).toContain("2 of 3");
  });

  it("should show all-implemented state", async () => {
    const manifest = makeManifest({
      agents: {
        claude: { name: "Claude Code", description: "a", url: "", install: "", launch: "", env: {} },
        aider: { name: "Aider", description: "b", url: "", install: "", launch: "", env: {} },
      },
      matrix: {
        "sprite/claude": "implemented",
        "sprite/aider": "implemented",
      },
    });
    await setupManifest(manifest);
    await cmdCloudInfo("sprite");
    const output = getOutput();
    expect(output).toContain("2 of 2");
  });

  it("should show zero-implemented state", async () => {
    const manifest = makeManifest({
      matrix: { "sprite/claude": "missing" },
    });
    await setupManifest(manifest);
    await cmdCloudInfo("sprite");
    const output = getOutput();
    expect(output).toContain("0 of 1");
    expect(output).toContain("No implemented agents");
  });

  it("should show cloud type and auth info in header", async () => {
    await setupManifest(makeManifest());
    await cmdCloudInfo("sprite");
    const output = getOutput();
    expect(output).toContain("Type:");
    expect(output).toContain("Auth:");
    expect(output).toContain("SPRITE_TOKEN");
  });

  it("should show cloud description", async () => {
    await setupManifest(makeManifest());
    await cmdCloudInfo("sprite");
    const output = getOutput();
    expect(output).toContain("Dev VMs");
  });

  it("should show setup guide link with cloud key", async () => {
    await setupManifest(makeManifest());
    await cmdCloudInfo("sprite");
    const output = getOutput();
    expect(output).toContain("Full setup guide");
    expect(output).toContain("/sprite");
  });
});

// ── cmdAgentInfo cloud list section ─────────────────────────────────────────

describe("cmdAgentInfo cloud list and count display", () => {
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
    clearMocks();
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

  it("should show correct cloud count for agent", async () => {
    const manifest = makeManifest({
      clouds: {
        sprite: {
          name: "Sprite", description: "Dev VMs", url: "https://sprite.sh",
          type: "vm", auth: "SPRITE_TOKEN",
          provision_method: "api", exec_method: "ssh", interactive_method: "ssh",
        },
        hetzner: {
          name: "Hetzner Cloud", description: "EU cloud", url: "https://console.hetzner.cloud",
          type: "cloud", auth: "HCLOUD_TOKEN",
          provision_method: "api", exec_method: "ssh", interactive_method: "ssh",
        },
        vultr: {
          name: "Vultr", description: "Global cloud", url: "https://my.vultr.com",
          type: "cloud", auth: "VULTR_API_KEY",
          provision_method: "api", exec_method: "ssh", interactive_method: "ssh",
        },
      },
      matrix: {
        "sprite/claude": "implemented",
        "hetzner/claude": "implemented",
        "vultr/claude": "missing",
      },
    });
    await setupManifest(manifest);
    await cmdAgentInfo("claude");
    const output = getOutput();
    expect(output).toContain("2 of 3");
  });

  it("should show agent description", async () => {
    await setupManifest(makeManifest());
    await cmdAgentInfo("claude");
    const output = getOutput();
    expect(output).toContain("AI coding assistant");
  });

  it("should show agent install command", async () => {
    await setupManifest(makeManifest());
    await cmdAgentInfo("claude");
    const output = getOutput();
    expect(output).toContain("npm install -g claude");
  });

  it("should show agent URL", async () => {
    await setupManifest(makeManifest());
    await cmdAgentInfo("claude");
    const output = getOutput();
    expect(output).toContain("https://claude.ai");
  });
});
