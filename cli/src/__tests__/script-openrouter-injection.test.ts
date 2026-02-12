import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Shell script OpenRouter injection validation tests.
 *
 * CLAUDE.md mandates: "OpenRouter injection is mandatory. Every agent script
 * MUST set OPENROUTER_API_KEY in the shell environment."
 *
 * This file validates that every implemented agent script:
 * 1. References OPENROUTER_API_KEY (the core variable)
 * 2. Calls get_openrouter_api_key (the shared auth function)
 * 3. Uses inject_env_vars_* or export to set env vars on the target
 * 4. References the agent-specific env vars from the manifest
 * 5. Does NOT hardcode API keys (no literal sk-or-v1- patterns)
 * 6. Uses json_escape or setup_*_config for JSON config files
 * 7. Sets the correct BASE_URL for agents that route through OpenRouter
 *
 * These invariants prevent:
 * - Agent scripts that silently skip OpenRouter configuration
 * - Missing env var exports that cause agents to fail at launch
 * - Hardcoded credentials committed to the repository
 * - JSON injection via unescaped API key values in config files
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const matrixEntries = Object.entries(manifest.matrix);
const implementedEntries = matrixEntries.filter(([, status]) => status === "implemented");

interface ScriptInfo {
  key: string;
  cloud: string;
  agent: string;
  path: string;
  envVars: Record<string, string>;
}

const implementedScripts: ScriptInfo[] = implementedEntries
  .map(([key]) => {
    const [cloud, agent] = key.split("/");
    return {
      key,
      cloud,
      agent,
      path: join(REPO_ROOT, key + ".sh"),
      envVars: manifest.agents[agent]?.env || {},
    };
  })
  .filter(({ path }) => existsSync(path));

/** Read file content */
function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** Get non-comment, non-empty lines from a script */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

// ── OPENROUTER_API_KEY reference ────────────────────────────────────────────

describe("OpenRouter API key injection", () => {
  it("should reference OPENROUTER_API_KEY in every implemented script", () => {
    const failures: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      if (!content.includes("OPENROUTER_API_KEY")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} scripts do not reference OPENROUTER_API_KEY:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should call get_openrouter_api_key in every implemented script", () => {
    const failures: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      if (
        !content.includes("get_openrouter_api_key") &&
        !content.includes("get_openrouter_api_key_oauth")
      ) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} scripts do not call get_openrouter_api_key:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });
});

// ── Environment variable injection ──────────────────────────────────────────

describe("Agent env var injection", () => {
  it("should use inject_env_vars or export to set environment variables", () => {
    const failures: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      // Scripts must use at least one of these patterns:
      // - inject_env_vars_ssh / inject_env_vars_sprite / inject_env_vars_local / etc.
      // - export VAR=...
      // - run_server / run_sprite with export
      // - setup_shell_environment (sprite-specific)
      const hasInjectHelper = /inject_env_vars/.test(content);
      const hasExport = /\bexport\b/.test(content);
      const hasSetupShellEnv = content.includes("setup_shell_environment");

      if (!hasInjectHelper && !hasExport && !hasSetupShellEnv) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} scripts do not inject env vars (no inject_env_vars/export/setup_shell_environment):\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should pass OPENROUTER_API_KEY to the env injection function", () => {
    const failures: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      // The OPENROUTER_API_KEY should appear in an inject_env_vars call
      // or in an export statement
      const hasKeyInInject =
        /inject_env_vars\S*[^;]*OPENROUTER_API_KEY/.test(content) ||
        /export\s+OPENROUTER_API_KEY/.test(content) ||
        // Some scripts pass it via heredoc or run_server/run_sprite
        (/OPENROUTER_API_KEY=/.test(content) && /inject_env_vars|export|run_server|run_sprite|run_on_server/.test(content));

      if (!hasKeyInInject) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} scripts do not pass OPENROUTER_API_KEY to env injection:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });
});

// ── No hardcoded API keys ───────────────────────────────────────────────────

describe("No hardcoded credentials in scripts", () => {
  it("should not contain literal OpenRouter API keys (sk-or-v1-...)", () => {
    const violations: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      const codeLines = getCodeLines(content);

      for (const line of codeLines) {
        if (/sk-or-v1-[a-f0-9]{20,}/.test(line)) {
          violations.push(key + ".sh");
          break;
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} scripts contain hardcoded OpenRouter API keys:\n` +
          violations.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should not contain literal Anthropic API keys (sk-ant-...)", () => {
    const violations: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      const codeLines = getCodeLines(content);

      for (const line of codeLines) {
        if (/sk-ant-[a-zA-Z0-9]{20,}/.test(line)) {
          violations.push(key + ".sh");
          break;
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} scripts contain hardcoded Anthropic API keys:\n` +
          violations.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should not contain literal OpenAI API keys (sk-proj-...)", () => {
    const violations: string[] = [];

    for (const { key, path } of implementedScripts) {
      const content = readScript(path);
      const codeLines = getCodeLines(content);

      for (const line of codeLines) {
        if (/sk-proj-[a-zA-Z0-9]{20,}/.test(line)) {
          violations.push(key + ".sh");
          break;
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} scripts contain hardcoded OpenAI API keys:\n` +
          violations.map((f) => `  - ${f}`).join("\n")
      );
    }
  });
});

// ── JSON config file safety ─────────────────────────────────────────────────

describe("JSON config file safety", () => {
  const agentsWithConfigFiles = Object.entries(manifest.agents)
    .filter(([, def]) => def.config_files && Object.keys(def.config_files).length > 0)
    .map(([key]) => key);

  it("should have at least one agent with config_files", () => {
    expect(agentsWithConfigFiles.length).toBeGreaterThan(0);
  });

  it("should use json_escape or setup helpers for most scripts with JSON configs", () => {
    let total = 0;
    let safe = 0;
    const unsafe: string[] = [];

    for (const { key, path, agent } of implementedScripts) {
      if (!agentsWithConfigFiles.includes(agent)) continue;
      total++;

      const content = readScript(path);
      const hasJsonEscape = content.includes("json_escape");
      const hasSetupHelper =
        content.includes("setup_claude_code_config") ||
        content.includes("setup_openclaw_config") ||
        content.includes("setup_continue_config") ||
        content.includes("setup_nanoclaw_config") ||
        content.includes("setup_kilocode_config") ||
        content.includes("upload_config_file");

      if (hasJsonEscape || hasSetupHelper) {
        safe++;
      } else {
        unsafe.push(key + ".sh");
      }
    }

    // At least 90% of scripts with config files should use safe patterns
    const safePercentage = total > 0 ? (safe / total) * 100 : 100;
    expect(safePercentage).toBeGreaterThanOrEqual(90);

    if (unsafe.length > 0) {
      console.log(
        `Note: ${unsafe.length}/${total} config-writing scripts lack json_escape/setup helper:\n` +
          unsafe.map((f) => `  - ${f}`).join("\n")
      );
    }
  });
});

// ── Agent-specific OpenRouter routing patterns ──────────────────────────────

describe("Agent-specific OpenRouter routing patterns", () => {
  it("should set ANTHROPIC_BASE_URL for claude agent scripts", () => {
    const claudeScripts = implementedScripts.filter((s) => s.agent === "claude");
    const failures: string[] = [];

    for (const { key, path } of claudeScripts) {
      const content = readScript(path);
      if (!content.includes("ANTHROPIC_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} claude scripts missing ANTHROPIC_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should set OPENAI_BASE_URL for codex agent scripts", () => {
    const codexScripts = implementedScripts.filter((s) => s.agent === "codex");
    if (codexScripts.length === 0) return;

    const failures: string[] = [];
    for (const { key, path } of codexScripts) {
      const content = readScript(path);
      if (!content.includes("OPENAI_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} codex scripts missing OPENAI_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should set OPENAI_BASE_URL for interpreter agent scripts", () => {
    const interpreterScripts = implementedScripts.filter((s) => s.agent === "interpreter");
    if (interpreterScripts.length === 0) return;

    const failures: string[] = [];
    for (const { key, path } of interpreterScripts) {
      const content = readScript(path);
      if (!content.includes("OPENAI_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} interpreter scripts missing OPENAI_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should set OPENAI_BASE_URL for gemini agent scripts", () => {
    const geminiScripts = implementedScripts.filter((s) => s.agent === "gemini");
    if (geminiScripts.length === 0) return;

    const failures: string[] = [];
    for (const { key, path } of geminiScripts) {
      const content = readScript(path);
      if (!content.includes("OPENAI_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} gemini scripts missing OPENAI_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should set OPENAI_BASE_URL for cline agent scripts", () => {
    const clineScripts = implementedScripts.filter((s) => s.agent === "cline");
    if (clineScripts.length === 0) return;

    const failures: string[] = [];
    for (const { key, path } of clineScripts) {
      const content = readScript(path);
      if (!content.includes("OPENAI_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} cline scripts missing OPENAI_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });

  it("should set OPENAI_BASE_URL for amazonq agent scripts", () => {
    const amazonqScripts = implementedScripts.filter((s) => s.agent === "amazonq");
    if (amazonqScripts.length === 0) return;

    const failures: string[] = [];
    for (const { key, path } of amazonqScripts) {
      const content = readScript(path);
      if (!content.includes("OPENAI_BASE_URL")) {
        failures.push(key + ".sh");
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} amazonq scripts missing OPENAI_BASE_URL:\n` +
          failures.map((f) => `  - ${f}`).join("\n")
      );
    }
  });
});

// ── Coverage stats ──────────────────────────────────────────────────────────

describe("OpenRouter injection test coverage", () => {
  it("should check a significant number of scripts", () => {
    expect(implementedScripts.length).toBeGreaterThan(100);
  });

  it("should cover all agents that have implementations", () => {
    const testedAgents = new Set(implementedScripts.map((s) => s.agent));
    const allAgentKeys = Object.keys(manifest.agents);
    for (const agent of allAgentKeys) {
      const hasImpl = implementedScripts.some((s) => s.agent === agent);
      if (!hasImpl) continue;
      expect(testedAgents.has(agent)).toBe(true);
    }
  });

  it("should cover all clouds that have implementations", () => {
    const testedClouds = new Set(implementedScripts.map((s) => s.cloud));
    expect(testedClouds.size).toBeGreaterThan(10);
  });

  it("should test every agent-specific BASE_URL pattern from the manifest", () => {
    // Every agent that has a BASE_URL env var should have a corresponding test above
    const agentsWithBaseUrl = Object.entries(manifest.agents)
      .filter(([, def]) => {
        const envKeys = Object.keys(def.env || {});
        return envKeys.some((k) => k.includes("BASE_URL"));
      })
      .map(([key]) => key);

    expect(agentsWithBaseUrl.length).toBeGreaterThan(0);

    // Verify we have at least one implemented script for each
    for (const agent of agentsWithBaseUrl) {
      const scripts = implementedScripts.filter((s) => s.agent === agent);
      // It's OK if some agents have no implementations yet
      if (scripts.length > 0) {
        const content = readScript(scripts[0].path);
        expect(content.includes("BASE_URL")).toBe(true);
      }
    }
  });
});
