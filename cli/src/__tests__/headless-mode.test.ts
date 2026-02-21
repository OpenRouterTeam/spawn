import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadManifest, type Manifest } from "../manifest";

/**
 * Tests for the headless SDK mode (--headless / --output json).
 *
 * cmdRunHeadless (commands.ts) provisions a server non-interactively and
 * outputs structured JSON (or plain text) with connection details.
 *
 * These tests cover:
 * - Validation errors (unknown agent, cloud, not implemented) exit with code 3
 * - Missing credentials exit with code 3
 * - JSON output structure for success and error cases
 * - Plain text output (headless without --output json)
 * - Script download failure exits with code 2
 * - Script execution failure exits with code 1
 * - Connection info is included when available
 *
 * Agent: refactor/ux-engineer
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
    local: {
      name: "Local",
      description: "Run locally",
      url: "",
      type: "local",
      auth: "none",
      provision_method: "local",
      exec_method: "local",
      interactive_method: "local",
    },
  },
  matrix: {
    "sprite/claude": "implemented",
    "hetzner/claude": "implemented",
    "local/claude": "implemented",
  },
};

// ── Mock setup ─────────────────────────────────────────────────────────────────

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
    step: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
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

const { cmdRunHeadless } = await import("../commands.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Headless mode (cmdRunHeadless)", () => {
  let originalFetch: typeof global.fetch;
  let originalExit: typeof process.exit;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let exitCode: number | undefined;
  let originalEnv: Record<string, string | undefined>;
  const SAVED_ENV_KEYS = ["SPRITE_TOKEN", "HCLOUD_TOKEN", "OPENROUTER_API_KEY"];

  function setupManifest(manifest: Manifest) {
    global.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      // Default: script not found
      return { ok: false, status: 404, text: async () => "Not found" };
    }) as any;
  }

  function setupManifestWithScript(manifest: Manifest, scriptContent: string) {
    global.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("manifest.json")) {
        return {
          ok: true,
          json: async () => manifest,
          text: async () => JSON.stringify(manifest),
        };
      }
      if (urlStr.includes(".sh")) {
        return { ok: true, text: async () => scriptContent };
      }
      return { ok: false, status: 404, text: async () => "Not found" };
    }) as any;
  }

  function getLogOutput(): string {
    return consoleLogSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function getErrorOutput(): string {
    return consoleErrorSpy.mock.calls.map((c: any[]) => c.join(" ")).join("\n");
  }

  function parseJsonOutput(): any {
    const output = getLogOutput();
    const lines = output.split("\n").filter(l => l.trim());
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  }

  beforeEach(async () => {
    originalFetch = global.fetch;
    originalExit = process.exit;
    exitCode = undefined;

    // Save env vars we might set
    originalEnv = {};
    for (const key of SAVED_ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }

    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Mock process.exit to capture exit code instead of actually exiting
    process.exit = mock((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`EXIT_${code ?? 0}`);
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.exit = originalExit;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();

    // Restore env
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  // ── Validation errors (exit code 3) ──────────────────────────────────

  describe("validation errors", () => {
    it("should error with UNKNOWN_AGENT for non-existent agent", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("nonexistent", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(3);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("UNKNOWN_AGENT");
    });

    it("should error with UNKNOWN_CLOUD for non-existent cloud", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);

      try {
        await cmdRunHeadless("claude", "nonexistent", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(3);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("UNKNOWN_CLOUD");
    });

    it("should error with NOT_IMPLEMENTED for missing matrix entry", async () => {
      const manifest: Manifest = {
        ...standardManifest,
        matrix: { "sprite/claude": "missing" },
      };
      setupManifest(manifest);
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(3);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("NOT_IMPLEMENTED");
    });

    it("should error with MISSING_CREDENTIALS when auth env var is not set", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      delete process.env.SPRITE_TOKEN;

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(3);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("MISSING_CREDENTIALS");
      expect(json.error_message).toContain("SPRITE_TOKEN");
    });

    it("should skip credential check when auth is 'none'", async () => {
      setupManifestWithScript(standardManifest, "#!/bin/bash\nexit 0");
      await loadManifest(true);

      try {
        await cmdRunHeadless("claude", "local", { outputFormat: "json" });
      } catch {}

      // Should not exit with code 3 for MISSING_CREDENTIALS
      // It might still fail on execution but not on validation
      if (exitCode === 3) {
        const json = parseJsonOutput();
        expect(json.error_code).not.toBe("MISSING_CREDENTIALS");
      }
    });
  });

  // ── Download errors (exit code 2) ────────────────────────────────────

  describe("download errors", () => {
    it("should error with DOWNLOAD_ERROR when script is not found", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(2);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("DOWNLOAD_ERROR");
    });
  });

  // ── JSON output structure ────────────────────────────────────────────

  describe("JSON output structure", () => {
    it("should include status, cloud, and agent in error output", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      delete process.env.SPRITE_TOKEN;

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      const json = parseJsonOutput();
      expect(json).toHaveProperty("status");
      expect(json).toHaveProperty("cloud");
      expect(json).toHaveProperty("agent");
      expect(json).toHaveProperty("error_code");
      expect(json).toHaveProperty("error_message");
    });

    it("should output valid JSON on stdout", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      delete process.env.SPRITE_TOKEN;

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      const output = getLogOutput();
      // Should be parseable JSON
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  // ── Plain text headless output ───────────────────────────────────────

  describe("plain text headless output", () => {
    it("should output error text to stderr when no --output json", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      delete process.env.SPRITE_TOKEN;

      try {
        await cmdRunHeadless("claude", "sprite", {});
      } catch {}

      // No JSON on stdout
      const logOutput = getLogOutput();
      expect(logOutput.trim()).toBe("");

      // Error on stderr
      const errOutput = getErrorOutput();
      expect(errOutput).toContain("Error:");
    });
  });

  // ── Execution (exit code 1) ──────────────────────────────────────────

  describe("execution errors", () => {
    it("should error with EXECUTION_ERROR when script exits non-zero", async () => {
      setupManifestWithScript(standardManifest, "#!/bin/bash\nexit 42");
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(1);
      const json = parseJsonOutput();
      expect(json.status).toBe("error");
      expect(json.error_code).toBe("EXECUTION_ERROR");
      expect(json.error_message).toContain("42");
    });

    it("should output success when script exits 0", async () => {
      setupManifestWithScript(standardManifest, "#!/bin/bash\nexit 0");
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      // Should not exit with error code (exitCode may be undefined if no process.exit called)
      if (exitCode !== undefined) {
        expect(exitCode).toBe(0);
      }
      const json = parseJsonOutput();
      expect(json.status).toBe("success");
      expect(json.cloud).toBe("sprite");
      expect(json.agent).toBe("claude");
    });
  });

  // ── Exit code contract ───────────────────────────────────────────────

  describe("exit code contract", () => {
    it("exit code 3 for validation errors", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);

      try {
        await cmdRunHeadless("nonexistent", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(3);
    });

    it("exit code 2 for download errors", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(2);
    });

    it("exit code 1 for execution errors", async () => {
      setupManifestWithScript(standardManifest, "#!/bin/bash\nexit 1");
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { outputFormat: "json" });
      } catch {}

      expect(exitCode).toBe(1);
    });
  });

  // ── HeadlessOptions interface ────────────────────────────────────────

  describe("HeadlessOptions", () => {
    it("should accept empty options object", async () => {
      setupManifest(standardManifest);
      await loadManifest(true);

      try {
        await cmdRunHeadless("nonexistent", "sprite", {});
      } catch {}

      // Should fail gracefully (validation error), not crash
      expect(exitCode).toBe(3);
    });

    it("should pass debug flag through", async () => {
      setupManifestWithScript(standardManifest, "#!/bin/bash\nexit 0");
      await loadManifest(true);
      process.env.SPRITE_TOKEN = "test-token";
      process.env.OPENROUTER_API_KEY = "sk-or-test";

      try {
        await cmdRunHeadless("claude", "sprite", { debug: true, outputFormat: "json" });
      } catch {}

      const errOutput = getErrorOutput();
      expect(errOutput).toContain("[headless]");
    });
  });
});
