import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { resolve } from "path";
import { mkdirSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for agent configuration and verification functions in shared/common.sh:
 * - verify_agent_installed: command existence and version check
 * - upload_config_file: temp file creation and callback invocation
 * - setup_claude_code_config: Claude Code settings.json + .claude.json generation
 * - setup_openclaw_config: OpenClaw openclaw.json generation
 * - setup_continue_config: Continue config.json generation
 *
 * These functions had zero test coverage despite being used by every agent
 * script across all cloud providers. They are security-relevant because they
 * inject API keys into JSON config files using json_escape.
 *
 * Each test sources shared/common.sh and calls the function in a real bash
 * subprocess to catch actual shell behavior (quoting, escaping, JSON structure).
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const COMMON_SH = resolve(REPO_ROOT, "shared/common.sh");

/**
 * Run a bash snippet that sources shared/common.sh first.
 * Returns { exitCode, stdout, stderr }.
 */
function runBash(script: string): { exitCode: number; stdout: string; stderr: string } {
  const fullScript = `source "${COMMON_SH}"\n${script}`;
  const { spawnSync } = require("child_process");
  const result = spawnSync("bash", ["-c", fullScript], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

/**
 * Create a temporary directory for test files.
 */
function createTempDir(): string {
  const dir = join(tmpdir(), `spawn-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── verify_agent_installed ──────────────────────────────────────────────────

describe("verify_agent_installed", () => {
  describe("command found and verifies", () => {
    it("should return 0 for a known command (bash)", () => {
      const result = runBash('verify_agent_installed "bash" "--version" "Bash"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("verified successfully");
    });

    it("should return 0 for ls with --help", () => {
      const result = runBash('verify_agent_installed "ls" "--help" "ls"');
      expect(result.exitCode).toBe(0);
    });

    it("should use --version as default verify arg", () => {
      // bash supports --version without second arg
      const result = runBash('verify_agent_installed "bash"');
      expect(result.exitCode).toBe(0);
    });

    it("should use command name as default agent name", () => {
      const result = runBash('verify_agent_installed "bash"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("bash");
      expect(result.stderr).toContain("verified successfully");
    });

    it("should display custom agent name in messages", () => {
      const result = runBash('verify_agent_installed "bash" "--version" "My Custom Agent"');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("My Custom Agent");
    });
  });

  describe("command not found", () => {
    it("should return 1 for non-existent command", () => {
      const result = runBash('verify_agent_installed "definitely_not_a_real_command_xyz"');
      expect(result.exitCode).toBe(1);
    });

    it("should show not found error message", () => {
      const result = runBash('verify_agent_installed "nonexistent_cmd_abc" "--version" "TestAgent"');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not found in PATH");
      expect(result.stderr).toContain("TestAgent");
    });

    it("should show troubleshooting hints on failure", () => {
      const result = runBash('verify_agent_installed "nonexistent_cmd_abc" "--version" "TestAgent"');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Possible causes");
      expect(result.stderr).toContain("How to fix");
    });

    it("should include command name in error output", () => {
      const result = runBash('verify_agent_installed "fake_agent_xyz" "--version" "FakeAgent"');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("fake_agent_xyz");
    });
  });

  describe("command exists but verification fails", () => {
    it("should return 1 when verify command fails", () => {
      // 'false' is a valid command that always returns 1
      const result = runBash('verify_agent_installed "true" "--nonexistent-flag-xyz" "TrueCmd"');
      // true command ignores flags and succeeds, so test with a script
      // Use a custom script that exists but fails verification
      const tempDir = createTempDir();
      try {
        const scriptPath = join(tempDir, "fake-agent");
        execSync(`echo '#!/bin/bash\nif [ "$1" = "--version" ]; then exit 1; fi' > "${scriptPath}" && chmod +x "${scriptPath}"`, {
          encoding: "utf-8",
        });
        const result2 = runBash(`PATH="${tempDir}:$PATH" verify_agent_installed "fake-agent" "--version" "FakeAgent"`);
        expect(result2.exitCode).toBe(1);
        expect(result2.stderr).toContain("verification failed");
        expect(result2.stderr).toContain("returned an error");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should show prerequisite hints on verification failure", () => {
      const tempDir = createTempDir();
      try {
        const scriptPath = join(tempDir, "bad-agent");
        execSync(`echo '#!/bin/bash\nexit 1' > "${scriptPath}" && chmod +x "${scriptPath}"`, {
          encoding: "utf-8",
        });
        const result = runBash(`PATH="${tempDir}:$PATH" verify_agent_installed "bad-agent" "--version" "BadAgent"`);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Missing runtime dependencies");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

// ── upload_config_file ──────────────────────────────────────────────────────

describe("upload_config_file", () => {
  it("should create a temp file with correct content", () => {
    const tempDir = createTempDir();
    try {
      // Use mock callbacks that record their arguments
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/uploaded_file"; echo "UPLOAD:$1:$2"; }
        mock_run() { echo "RUN:$1"; }
        upload_config_file "mock_upload" "mock_run" "hello world content" "/remote/path/config.json"
      `);
      expect(result.exitCode).toBe(0);
      // Verify the content was uploaded
      const uploadedContent = readFileSync(join(tempDir, "uploaded_file"), "utf-8");
      expect(uploadedContent.trim()).toBe("hello world content");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should invoke upload callback with temp file and remote temp path", () => {
    const result = runBash(`
      mock_upload() { echo "UPLOAD:$1:$2"; }
      mock_run() { echo "RUN:$1"; }
      upload_config_file "mock_upload" "mock_run" "test content" "~/.config/app.json"
    `);
    expect(result.exitCode).toBe(0);
    // Should contain UPLOAD line
    expect(result.stdout).toContain("UPLOAD:");
    // Remote temp path should contain spawn_config prefix
    expect(result.stdout).toContain("spawn_config");
    // Should have a basename of the remote path
    expect(result.stdout).toContain("app.json");
  });

  it("should invoke run callback with mv command", () => {
    const result = runBash(`
      mock_upload() { echo "UPLOAD"; }
      mock_run() { echo "RUN:$1"; }
      upload_config_file "mock_upload" "mock_run" "test" "~/.config/test.json"
    `);
    expect(result.exitCode).toBe(0);
    // Should run chmod and mv to move temp file to final path
    expect(result.stdout).toContain("RUN:chmod");
    expect(result.stdout).toContain("mv");
    expect(result.stdout).toContain("~/.config/test.json");
  });

  it("should preserve multiline content", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/uploaded"; }
        mock_run() { :; }
        upload_config_file "mock_upload" "mock_run" '{"key": "value",
  "nested": true}' "/remote/config.json"
      `);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(tempDir, "uploaded"), "utf-8").trim();
      expect(content).toContain('"key": "value"');
      expect(content).toContain('"nested": true');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle special characters in content", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/uploaded"; }
        mock_run() { :; }
        upload_config_file "mock_upload" "mock_run" 'key with $dollar and "quotes"' "/remote/config"
      `);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(tempDir, "uploaded"), "utf-8").trim();
      expect(content).toContain("$dollar");
      expect(content).toContain('"quotes"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── setup_claude_code_config ────────────────────────────────────────────────

describe("setup_claude_code_config", () => {
  describe("generates valid JSON", () => {
    it("should produce valid settings.json", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "sk-or-v1-test-key-123" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        // Find the settings.json file (named with spawn_config prefix)
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        expect(settingsFile).toBeDefined();
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should include OpenRouter base URL in settings", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "sk-or-v1-test" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should include API key in settings via json_escape", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "my-test-api-key-value" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("my-test-api-key-value");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should set bypass permissions in settings", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "key123" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.permissions.dangerouslySkipPermissions).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should disable telemetry in settings", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "key123" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should produce valid .claude.json with onboarding completed", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "key" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const claudeFile = files.find(f => f.includes(".claude.json"));
        expect(claudeFile).toBeDefined();
        const content = readFileSync(join(tempDir, claudeFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.hasCompletedOnboarding).toBe(true);
        expect(parsed.bypassPermissionsModeAccepted).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should create both settings.json and .claude.json files", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config "key" "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        expect(files.some(f => f.includes("settings.json"))).toBe(true);
        expect(files.some(f => f.includes(".claude.json"))).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should invoke run callback to create .claude directory", () => {
      const result = runBash(`
        mock_upload() { :; }
        mock_run() { echo "CMD:$1"; }
        setup_claude_code_config "key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CMD:mkdir -p ~/.claude");
    });

    it("should invoke run callback to create CLAUDE.md", () => {
      const result = runBash(`
        mock_upload() { :; }
        mock_run() { echo "CMD:$1"; }
        setup_claude_code_config "key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CMD:touch ~/.claude/CLAUDE.md");
    });
  });

  describe("json_escape security", () => {
    it("should safely escape API key with double quotes", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config 'key-with-"quotes"-inside' "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        // Should be valid JSON even with quotes in the key
        const parsed = JSON.parse(content);
        expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toContain("quotes");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should safely escape API key with backslashes", () => {
      const tempDir = createTempDir();
      try {
        const result = runBash(`
          mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
          mock_run() { :; }
          setup_claude_code_config 'key\\with\\backslashes' "mock_upload" "mock_run"
        `);
        expect(result.exitCode).toBe(0);
        const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
        const settingsFile = files.find(f => f.includes("settings.json"));
        const content = readFileSync(join(tempDir, settingsFile!), "utf-8");
        const parsed = JSON.parse(content);
        expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

// ── setup_openclaw_config ───────────────────────────────────────────────────

describe("setup_openclaw_config", () => {
  it("should produce valid openclaw.json", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_openclaw_config "sk-or-v1-test-key" "openrouter/auto" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const opClawFile = files.find(f => f.includes("openclaw.json"));
      expect(opClawFile).toBeDefined();
      const content = readFileSync(join(tempDir, opClawFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include OPENROUTER_API_KEY in env section", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_openclaw_config "my-api-key-123" "openrouter/auto" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const opClawFile = files.find(f => f.includes("openclaw.json"));
      const content = readFileSync(join(tempDir, opClawFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.env.OPENROUTER_API_KEY).toBe("my-api-key-123");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include model ID in agents.defaults.model.primary", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_openclaw_config "key" "anthropic/claude-3.5-sonnet" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const opClawFile = files.find(f => f.includes("openclaw.json"));
      const content = readFileSync(join(tempDir, opClawFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.agents.defaults.model.primary).toBe("openrouter/anthropic/claude-3.5-sonnet");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include gateway config with local mode", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_openclaw_config "key" "auto" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const opClawFile = files.find(f => f.includes("openclaw.json"));
      const content = readFileSync(join(tempDir, opClawFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.gateway.mode).toBe("local");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should generate a gateway auth token", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_openclaw_config "key" "auto" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const opClawFile = files.find(f => f.includes("openclaw.json"));
      const content = readFileSync(join(tempDir, opClawFile!), "utf-8");
      const parsed = JSON.parse(content);
      // Gateway token should be a 32-char hex string (openssl rand -hex 16)
      expect(parsed.gateway.auth.token).toBeDefined();
      expect(typeof parsed.gateway.auth.token).toBe("string");
      expect(parsed.gateway.auth.token.length).toBe(32);
      expect(parsed.gateway.auth.token).toMatch(/^[0-9a-f]+$/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should invoke run callback to clean and create .openclaw directory", () => {
    const result = runBash(`
      mock_upload() { :; }
      mock_run() { echo "CMD:$1"; }
      setup_openclaw_config "key" "auto" "mock_upload" "mock_run"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CMD:rm -rf ~/.openclaw && mkdir -p ~/.openclaw");
  });
});

// ── setup_continue_config ───────────────────────────────────────────────────

describe("setup_continue_config", () => {
  it("should produce valid config.json", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config "sk-or-v1-test-key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      expect(configFile).toBeDefined();
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include OpenRouter model config", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config "test-key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.models).toBeArray();
      expect(parsed.models.length).toBeGreaterThan(0);
      expect(parsed.models[0].provider).toBe("openrouter");
      expect(parsed.models[0].model).toBe("openrouter/auto");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should include API key from json_escape", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config "my-continue-api-key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.models[0].apiKey).toBe("my-continue-api-key");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should set apiBase to OpenRouter API v1", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config "key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.models[0].apiBase).toBe("https://openrouter.ai/api/v1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should set title to OpenRouter", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config "key" "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.models[0].title).toBe("OpenRouter");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should invoke run callback to create .continue directory", () => {
    const result = runBash(`
      mock_upload() { :; }
      mock_run() { echo "CMD:$1"; }
      setup_continue_config "key" "mock_upload" "mock_run"
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CMD:mkdir -p ~/.continue");
  });

  it("should safely handle API key with special JSON characters", () => {
    const tempDir = createTempDir();
    try {
      const result = runBash(`
        mock_upload() { cp "$1" "${tempDir}/$(basename "$2")"; }
        mock_run() { :; }
        setup_continue_config 'key-with-"quotes"-and\\backslash' "mock_upload" "mock_run"
      `);
      expect(result.exitCode).toBe(0);
      const files = execSync(`ls "${tempDir}"`, { encoding: "utf-8" }).trim().split("\n");
      const configFile = files.find(f => f.includes("config.json"));
      const content = readFileSync(join(tempDir, configFile!), "utf-8");
      // Must be valid JSON even with special characters
      const parsed = JSON.parse(content);
      expect(parsed.models[0].apiKey).toContain("quotes");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
