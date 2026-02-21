import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for the dry-run preview feature (showDryRunPreview via cmdRun).
 *
 * showDryRunPreview (commands.ts:328-372) renders agent info, cloud info,
 * script URL, environment variables, and an optional prompt without
 * provisioning any resources. It was added in PR #479.
 *
 * These tests cover:
 * - Basic output structure (section headers, completion message)
 * - Agent info display (name, description, install, launch)
 * - Cloud info display (name, description, defaults)
 * - Script URL format
 * - Environment variable display with OPENROUTER_API_KEY redaction
 * - Prompt display with truncation at 100 characters
 * - No script download occurs in dry-run mode
 * - Different agent/cloud combinations
 * - Minimal agent (no install/launch/env)
 *
 * Agent: test-engineer
 */

// ── Manifests ──────────────────────────────────────────────────────────────────

const standardManifest: Manifest = {
  agents: {
    claude: {
      name: "Claude Code",
      description: "AI coding assistant by Anthropic",
      url: "https://claude.ai",
      install: "npm install -g @anthropic-ai/claude-code",
      launch: "claude",
      env: {
        ANTHROPIC_API_KEY: "$OPENROUTER_API_KEY",
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      },
    },
    codex: {
      name: "Codex",
      description: "AI pair programmer",
      url: "https://codex.dev",
      install: "npm install -g codex",
      launch: "codex",
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
      auth: "SPRITE_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
      defaults: {
        region: "us-east-1",
        size: "small",
      },
    },
    hetzner: {
      name: "Hetzner Cloud",
      description: "European cloud provider",
      url: "https://hetzner.com",
      type: "cloud",
      auth: "HCLOUD_TOKEN",
      provision_method: "api",
      exec_method: "ssh",
      interactive_method: "ssh",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "sprite/codex": "implemented",
    "hetzner/claude": "implemented",
    "hetzner/codex": "missing",
  },
};

const minimalAgentManifest: Manifest = {
  agents: {
    bare: {
      name: "Bare Agent",
      description: "Agent with minimal fields",
      url: "https://example.com",
      install: "",
      launch: "",
      env: {},
    },
  },
  clouds: {
    testcloud: {
      name: "Test Cloud",
      description: "A test cloud",
      url: "https://testcloud.example.com",
      type: "container",
      auth: "TEST_TOKEN",
      provision_method: "cli",
      exec_method: "exec",
      interactive_method: "exec",
    },
  },
  matrix: {
    "testcloud/bare": "implemented",
  },
};

// ── Mock setup ─────────────────────────────────────────────────────────────────

const mockLogError = mock(() => {});
const mockLogInfo = mock(() => {});
const mockLogStep = mock(() => {});
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
    warn: mock(() => {}),
    error: mockLogError,
    success: mockLogSuccess,
  },
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  select: mock(() => {}),
  autocomplete: mock(async () => "claude"),
  text: mock(async () => undefined),
  isCancel: () => false,
}));

const { cmdRun } = await import("../commands.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Dry-run preview (showDryRunPreview via cmdRun)", () => {
  let originalFetch: typeof global.fetch;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async () => ({
      ok: true,
      json: async () => manifest,
      text: async () => JSON.stringify(manifest),
    })) as any;
  }

  function clearMocks() {
    mockLogError.mockClear();
    mockLogInfo.mockClear();
    mockLogStep.mockClear();
    mockLogSuccess.mockClear();
    mockSpinnerStart.mockClear();
    mockSpinnerStop.mockClear();
    mockSpinnerMessage.mockClear();
  }

  function getLogText(): string {
    return consoleLogSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function getStepCalls(): string[] {
    return mockLogStep.mock.calls.map((c: any[]) => c.join(" "));
  }

  function getInfoCalls(): string[] {
    return mockLogInfo.mock.calls.map((c: any[]) => c.join(" "));
  }

  function getSuccessCalls(): string[] {
    return mockLogSuccess.mock.calls.map((c: any[]) => c.join(" "));
  }

  beforeEach(async () => {
    clearMocks();
    originalFetch = global.fetch;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ── Basic output structure ───────────────────────────────────────────

  describe("basic output structure", () => {
    it("should show 'Dry run' info message at the start", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getInfoCalls().some(c => c.includes("Dry run"))).toBe(true);
    });

    it("should show 'no resources will be provisioned' at the start", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getInfoCalls().some(c => c.includes("no resources"))).toBe(true);
    });

    it("should show 'Dry run complete' success message", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getSuccessCalls().some(c => c.includes("Dry run complete"))).toBe(true);
    });

    it("should show 'no resources were provisioned' in completion", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getSuccessCalls().some(c => c.includes("no resources were provisioned"))).toBe(true);
    });

    it("should not fetch .sh script files during dry-run", async () => {
      const fetchedUrls: string[] = [];
      global.fetch = mock(async (url: string) => {
        if (typeof url === "string") fetchedUrls.push(url);
        return {
          ok: true,
          json: async () => standardManifest,
          text: async () => JSON.stringify(standardManifest),
        };
      }) as any;

      await loadManifest(true);
      fetchedUrls.length = 0;

      await cmdRun("claude", "sprite", undefined, true);

      const scriptFetches = fetchedUrls.filter(u => u.includes(".sh"));
      expect(scriptFetches).toHaveLength(0);
    });

    it("should return without error (no process.exit)", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);

      // Should complete without throwing
      await cmdRun("claude", "sprite", undefined, true);
      expect(getSuccessCalls().length).toBeGreaterThan(0);
    });
  });

  // ── Agent section ────────────────────────────────────────────────────

  describe("agent information", () => {
    it("should show Agent section header", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getStepCalls().some(c => c.includes("Agent"))).toBe(true);
    });

    it("should display agent name", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("Claude Code");
    });

    it("should display agent description", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("AI coding assistant by Anthropic");
    });

    it("should display install command", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("npm install -g @anthropic-ai/claude-code");
    });

    it("should display launch command", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const text = getLogText();
      expect(text).toContain("Launch:");
      expect(text).toContain("claude");
    });

    it("should not show Install line when install is empty", async () => {
      setupManifest(minimalAgentManifest);
      await loadManifest(true);
      await cmdRun("bare", "testcloud", undefined, true);

      expect(getLogText()).not.toContain("Install:");
    });

    it("should not show Launch line when launch is empty", async () => {
      setupManifest(minimalAgentManifest);
      await loadManifest(true);
      await cmdRun("bare", "testcloud", undefined, true);

      expect(getLogText()).not.toContain("Launch:");
    });
  });

  // ── Cloud section ────────────────────────────────────────────────────

  describe("cloud information", () => {
    it("should show Cloud section header", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getStepCalls().some(c => c.includes("Cloud"))).toBe(true);
    });

    it("should display cloud name", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("Sprite");
    });

    it("should display cloud description", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("Lightweight VMs");
    });

    it("should display cloud defaults when present", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const text = getLogText();
      expect(text).toContain("Defaults:");
      expect(text).toContain("region");
      expect(text).toContain("us-east-1");
      expect(text).toContain("size");
      expect(text).toContain("small");
    });

    it("should not show Defaults section when cloud has no defaults", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "hetzner", undefined, true);

      expect(getLogText()).not.toContain("Defaults:");
    });
  });

  // ── Script URL ──────────────────────────────────────────────────────

  describe("script URL", () => {
    it("should show Script section header", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getStepCalls().some(c => c.includes("Script"))).toBe(true);
    });

    it("should display script URL with cloud/agent path", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("sprite/claude.sh");
    });

    it("should use GitHub raw URL", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("raw.githubusercontent.com/OpenRouterTeam/spawn/main");
    });
  });

  // ── Environment variables ──────────────────────────────────────────

  describe("environment variables", () => {
    it("should show Environment variables section header", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getStepCalls().some(c => c.includes("Environment"))).toBe(true);
    });

    it("should display ANTHROPIC_API_KEY", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("ANTHROPIC_API_KEY");
    });

    it("should display ANTHROPIC_BASE_URL with its value", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const text = getLogText();
      expect(text).toContain("ANTHROPIC_BASE_URL");
      expect(text).toContain("https://openrouter.ai/api");
    });

    it("should redact OPENROUTER_API_KEY references as '(from OpenRouter)'", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getLogText()).toContain("(from OpenRouter)");
    });

    it("should show non-OPENROUTER values as-is", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("codex", "sprite", undefined, true);

      expect(getLogText()).toContain("OPENAI_API_KEY=test-key");
    });

    it("should not display env var lines when agent env is empty object", async () => {
      setupManifest(minimalAgentManifest);
      await loadManifest(true);
      await cmdRun("bare", "testcloud", undefined, true);

      const text = getLogText();
      // No KEY=value lines should appear
      expect(text).not.toMatch(/[A-Z_]+=\S/);
    });
  });

  // ── Prompt display ──────────────────────────────────────────────────

  describe("prompt display", () => {
    it("should show Prompt section header when prompt provided", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", "Fix linter errors", true);

      expect(getStepCalls().some(c => c.includes("Prompt"))).toBe(true);
    });

    it("should display short prompt in full", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", "Fix all linter errors", true);

      expect(getLogText()).toContain("Fix all linter errors");
    });

    it("should truncate prompts longer than 100 characters with ...", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      const longPrompt = "A".repeat(150);
      await cmdRun("claude", "sprite", longPrompt, true);

      const text = getLogText();
      expect(text).toContain("A".repeat(100) + "...");
      expect(text).not.toContain("A".repeat(101));
    });

    it("should display exactly 100-char prompt without truncation", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      const exactPrompt = "B".repeat(100);
      await cmdRun("claude", "sprite", exactPrompt, true);

      const text = getLogText();
      expect(text).toContain("B".repeat(100));
      // The 100-char string should appear without trailing "..."
      const lines = consoleLogSpy.mock.calls.map((c: any[]) => c.join(" "));
      const promptLine = lines.find(l => l.includes("B".repeat(50)));
      expect(promptLine).toBeDefined();
      expect(promptLine!.endsWith("...")).toBe(false);
    });

    it("should truncate 101-char prompt", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      const prompt101 = "C".repeat(101);
      await cmdRun("claude", "sprite", prompt101, true);

      const text = getLogText();
      expect(text).toContain("C".repeat(100) + "...");
    });

    it("should not show Prompt section when no prompt", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      expect(getStepCalls().some(c => c.includes("Prompt"))).toBe(false);
    });
  });

  // ── Different combinations ─────────────────────────────────────────

  describe("different agent/cloud combinations", () => {
    it("should work with codex on sprite", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("codex", "sprite", undefined, true);

      const text = getLogText();
      expect(text).toContain("Codex");
      expect(text).toContain("AI pair programmer");
      expect(text).toContain("sprite/codex.sh");
      expect(getSuccessCalls().some(c => c.includes("Dry run complete"))).toBe(true);
    });

    it("should work with claude on hetzner (cloud without defaults)", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "hetzner", undefined, true);

      const text = getLogText();
      expect(text).toContain("Claude Code");
      expect(text).toContain("Hetzner Cloud");
      expect(text).toContain("European cloud provider");
      expect(text).toContain("hetzner/claude.sh");
      expect(text).not.toContain("Defaults:");
    });

    it("should work with minimal agent (empty install, launch, env)", async () => {
      setupManifest(minimalAgentManifest);
      await loadManifest(true);
      await cmdRun("bare", "testcloud", undefined, true);

      const text = getLogText();
      expect(text).toContain("Bare Agent");
      expect(text).toContain("Test Cloud");
      expect(getSuccessCalls().some(c => c.includes("Dry run complete"))).toBe(true);
    });

    it("should include prompt with different agent/cloud", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("codex", "sprite", "Add unit tests", true);

      const text = getLogText();
      expect(text).toContain("Add unit tests");
      expect(getStepCalls().some(c => c.includes("Prompt"))).toBe(true);
    });
  });

  // ── Section ordering ──────────────────────────────────────────────

  describe("section ordering", () => {
    it("should show Agent before Cloud section", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const steps = getStepCalls();
      const agentIdx = steps.findIndex(c => c.includes("Agent"));
      const cloudIdx = steps.findIndex(c => c.includes("Cloud"));
      expect(agentIdx).toBeLessThan(cloudIdx);
    });

    it("should show Cloud before Script section", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const steps = getStepCalls();
      const cloudIdx = steps.findIndex(c => c.includes("Cloud"));
      const scriptIdx = steps.findIndex(c => c.includes("Script"));
      expect(cloudIdx).toBeLessThan(scriptIdx);
    });

    it("should show Script before Environment section", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", undefined, true);

      const steps = getStepCalls();
      const scriptIdx = steps.findIndex(c => c.includes("Script"));
      const envIdx = steps.findIndex(c => c.includes("Environment"));
      expect(scriptIdx).toBeLessThan(envIdx);
    });

    it("should show Environment before Prompt section", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      await cmdRun("claude", "sprite", "test prompt", true);

      const steps = getStepCalls();
      const envIdx = steps.findIndex(c => c.includes("Environment"));
      const promptIdx = steps.findIndex(c => c.includes("Prompt"));
      expect(envIdx).toBeLessThan(promptIdx);
    });
  });
});
