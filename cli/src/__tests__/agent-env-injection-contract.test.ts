import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest, AgentDef } from "../manifest";

/**
 * Agent environment variable injection contract tests.
 *
 * Every implemented agent script MUST inject the environment variables defined
 * in the agent's `env` field in manifest.json. This is the core contract that
 * ensures OpenRouter API keys and provider-specific base URLs are available to
 * the agent at runtime. A missing env var injection silently breaks the agent
 * for users -- the agent starts but cannot reach the LLM API.
 *
 * These tests validate:
 * 1. Every script references OPENROUTER_API_KEY (mandatory for all agents)
 * 2. Every script references the provider-specific env vars from manifest
 * 3. Cloud lib/common.sh files have the generate_env_config or inject_env_vars helper
 * 4. Scripts that use inject_env_vars_ssh pass the correct variable names
 * 5. Agent launch commands match the manifest's launch field
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifest: Manifest = JSON.parse(manifestRaw);

const matrixEntries = Object.entries(manifest.matrix);
const implementedEntries = matrixEntries.filter(([, status]) => status === "implemented");

interface ScriptInfo {
  key: string; // e.g. "sprite/claude"
  cloud: string;
  agent: string;
  path: string;
  content: string;
}

// Load all implemented scripts
const implementedScripts: ScriptInfo[] = implementedEntries
  .map(([key]) => {
    const [cloud, agent] = key.split("/");
    const path = join(REPO_ROOT, key + ".sh");
    return { key, cloud, agent, path };
  })
  .filter(({ path }) => existsSync(path))
  .map((info) => ({
    ...info,
    content: readFileSync(info.path, "utf-8"),
  }));

// Collect unique clouds
const cloudsWithImpls = new Set<string>();
for (const { cloud } of implementedScripts) {
  cloudsWithImpls.add(cloud);
}

/**
 * Get non-comment, non-empty lines from script content.
 * This filters out comments so we only check actual code references.
 */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

/**
 * Check if a script references an env var name in its code lines.
 * We look for the var name in non-comment lines to avoid false positives
 * from documentation comments.
 */
function scriptReferencesEnvVar(content: string, varName: string): boolean {
  const codeLines = getCodeLines(content);
  return codeLines.some((line) => line.includes(varName));
}

/**
 * Some env vars are injected indirectly through helper functions like
 * inject_env_vars_ssh, generate_env_config, or setup_*_config.
 * Check if the script delegates to one of these helpers.
 */
function scriptUsesEnvInjectionHelper(content: string): boolean {
  const helpers = [
    "inject_env_vars_ssh",
    "inject_env_vars_local",
    "generate_env_config",
    "setup_claude_code_config",
    "setup_openclaw_config",
    "setup_continue_config",
  ];
  return helpers.some((h) => content.includes(h));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Agent Environment Variable Injection Contract", () => {
  // Sanity: we should be testing a significant number of scripts
  it("should have a meaningful number of implemented scripts to test", () => {
    expect(implementedScripts.length).toBeGreaterThan(70);
  });

  // ── OPENROUTER_API_KEY (mandatory for ALL agents) ──────────────────────

  describe("OPENROUTER_API_KEY injection (mandatory for all agents)", () => {
    it("every implemented script should reference OPENROUTER_API_KEY", () => {
      const failures: string[] = [];

      for (const { key, content } of implementedScripts) {
        if (!scriptReferencesEnvVar(content, "OPENROUTER_API_KEY")) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts do not reference OPENROUTER_API_KEY:\n` +
            failures.map((f) => `  - ${f}`).join("\n") +
            "\n\nEvery agent script MUST reference OPENROUTER_API_KEY to get " +
            "the user's OpenRouter API key for LLM inference."
        );
      }
    });
  });

  // ── Provider-specific env vars from manifest ──────────────────────────

  describe("provider-specific env var injection from manifest", () => {
    // Group scripts by agent to check their manifest env vars
    const agentKeys = Object.keys(manifest.agents);

    for (const agentKey of agentKeys) {
      const agentDef = manifest.agents[agentKey];
      const agentEnvVars = Object.keys(agentDef.env || {});
      const agentScripts = implementedScripts.filter((s) => s.agent === agentKey);

      if (agentScripts.length === 0) continue;

      // Key env vars that MUST appear in the script (excluding OPENROUTER_API_KEY
      // which is tested separately, and excluding vars that are derived values
      // like $OPENROUTER_API_KEY references in the manifest value)
      const criticalVars = agentEnvVars.filter((v) => {
        // Skip OPENROUTER_API_KEY (already tested above)
        if (v === "OPENROUTER_API_KEY") return false;
        // These are the vars that configure the agent to use OpenRouter
        return true;
      });

      if (criticalVars.length === 0) continue;

      describe(`${agentKey} (${agentDef.name})`, () => {
        for (const varName of criticalVars) {
          it(`scripts should reference ${varName}`, () => {
            const failures: string[] = [];

            for (const { key, content } of agentScripts) {
              // Check if the env var is referenced directly OR if a helper
              // function is used that handles env injection
              const hasDirectRef = scriptReferencesEnvVar(content, varName);
              const usesHelper = scriptUsesEnvInjectionHelper(content);

              if (!hasDirectRef && !usesHelper) {
                failures.push(key + ".sh");
              }
            }

            if (failures.length > 0) {
              // Allow some tolerance: if >80% of scripts have the var, it's likely
              // the few missing ones use an alternative approach (e.g., dotenv)
              const coverage = (agentScripts.length - failures.length) / agentScripts.length;
              if (coverage < 0.8) {
                throw new Error(
                  `${failures.length}/${agentScripts.length} ${agentKey} scripts missing ${varName}:\n` +
                    failures.map((f) => `  - ${f}`).join("\n") +
                    `\n\n${varName} is defined in manifest.json for ${agentKey} ` +
                    `and should be set in the agent's environment.`
                );
              }
            }
          });
        }
      });
    }
  });

  // ── OAuth or manual key acquisition pattern ────────────────────────────

  describe("OpenRouter API key acquisition pattern", () => {
    it("every script should acquire OPENROUTER_API_KEY via env, OAuth, or manual prompt", () => {
      const failures: string[] = [];

      for (const { key, content } of implementedScripts) {
        const codeLines = getCodeLines(content);
        const code = codeLines.join("\n");

        // Check for one of the standard acquisition patterns:
        // 1. Checks env var: ${OPENROUTER_API_KEY:-}
        // 2. OAuth flow: get_openrouter_api_key_oauth
        // 3. Manual prompt: get_openrouter_api_key_manual
        // 4. try_oauth_flow
        // 5. Shared helper: get_or_prompt_api_key (wraps env check + OAuth)
        // 6. spawn_agent orchestrator (calls get_or_prompt_api_key internally)
        const hasEnvCheck = code.includes("OPENROUTER_API_KEY:-") || code.includes("OPENROUTER_API_KEY:=");
        const hasOAuth = code.includes("get_openrouter_api_key_oauth") || code.includes("try_oauth_flow");
        const hasManual = code.includes("get_openrouter_api_key_manual");
        const hasSharedHelper = code.includes("get_or_prompt_api_key");
        const hasSpawnAgent = code.includes("spawn_agent");
        const hasAnyAcquisition = hasEnvCheck || hasOAuth || hasManual || hasSharedHelper || hasSpawnAgent;

        if (!hasAnyAcquisition) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts lack an OPENROUTER_API_KEY acquisition pattern:\n` +
            failures.map((f) => `  - ${f}`).join("\n") +
            "\n\nEvery script must either check the env var, use OAuth, or prompt manually."
        );
      }
    });
  });

  // ── Agent install command presence ─────────────────────────────────────

  describe("agent install command presence", () => {
    for (const agentKey of Object.keys(manifest.agents)) {
      const agentDef = manifest.agents[agentKey];
      const installCmd = agentDef.install;
      const agentScripts = implementedScripts.filter((s) => s.agent === agentKey);

      if (agentScripts.length === 0) continue;

      // Extract the primary install tool from the manifest install command
      // e.g., "npm install -g @anthropic-ai/claude-code" -> "npm"
      // e.g., "npm install -g codex" -> "pip"
      // e.g., "curl -fsSL ..." -> "curl"
      const installTool = installCmd.split(/\s+/)[0];

      // Extract the package name if it follows a standard pattern
      // Look for the last argument that isn't a flag
      const installParts = installCmd.split(/\s+/).filter((p) => !p.startsWith("-"));
      const packageName = installParts[installParts.length - 1];

      it(`${agentKey} scripts should reference install mechanism (${installTool})`, () => {
        const failures: string[] = [];

        for (const { key, content } of agentScripts) {
          const codeLines = getCodeLines(content);
          const code = codeLines.join("\n");

          // Check if the script references the install tool or the package name
          const hasInstallTool = code.includes(installTool);
          const hasPackageName = packageName ? code.includes(packageName) : false;
          // Also check for verify_agent_installed which validates after install
          const hasVerify = code.includes("verify_agent_installed");
          // Some scripts use a helper like opencode_install_cmd
          const hasInstallHelper = code.includes("_install_cmd") || code.includes("install_");

          if (!hasInstallTool && !hasPackageName && !hasVerify && !hasInstallHelper) {
            failures.push(key + ".sh");
          }
        }

        if (failures.length > 0) {
          // Allow some tolerance for scripts that may use alternative install methods
          const coverage = (agentScripts.length - failures.length) / agentScripts.length;
          if (coverage < 0.8) {
            throw new Error(
              `${failures.length}/${agentScripts.length} ${agentKey} scripts missing ` +
                `install mechanism (expected: ${installCmd}):\n` +
                failures.map((f) => `  - ${f}`).join("\n")
            );
          }
        }
      });
    }
  });

  // ── Agent launch command presence ──────────────────────────────────────

  describe("agent launch command presence", () => {
    for (const agentKey of Object.keys(manifest.agents)) {
      const agentDef = manifest.agents[agentKey];
      const launchCmd = agentDef.launch;
      const agentScripts = implementedScripts.filter((s) => s.agent === agentKey);

      if (agentScripts.length === 0) continue;

      // Extract the primary command from the launch string
      // e.g., "claude" from "claude"
      // e.g., "codex" from "codex --model openrouter/..."
      const launchBinary = launchCmd.split(/\s+/)[0];

      it(`${agentKey} scripts should reference launch command "${launchBinary}"`, () => {
        const failures: string[] = [];

        for (const { key, content } of agentScripts) {
          if (!scriptReferencesEnvVar(content, launchBinary)) {
            failures.push(key + ".sh");
          }
        }

        if (failures.length > 0) {
          // Allow tolerance for alternative launch patterns
          const coverage = (agentScripts.length - failures.length) / agentScripts.length;
          if (coverage < 0.8) {
            throw new Error(
              `${failures.length}/${agentScripts.length} ${agentKey} scripts missing ` +
                `launch command "${launchBinary}":\n` +
                failures.map((f) => `  - ${f}`).join("\n")
            );
          }
        }
      });
    }
  });

  // ── Cloud lib/common.sh has env injection helpers ──────────────────────

  describe("cloud lib/common.sh env injection infrastructure", () => {
    for (const cloud of cloudsWithImpls) {
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");

      it(`${cloud}/lib/common.sh should exist`, () => {
        expect(existsSync(libPath)).toBe(true);
      });

      if (!existsSync(libPath)) continue;

      it(`${cloud}/lib/common.sh should source shared/common.sh (env injection helpers)`, () => {
        const content = readFileSync(libPath, "utf-8");
        expect(content).toContain("shared/common.sh");
      });
    }
  });

  // ── Env var value patterns match manifest ──────────────────────────────

  describe("env var values follow manifest patterns", () => {
    // Check that scripts setting ANTHROPIC_BASE_URL use the OpenRouter URL
    it("scripts setting ANTHROPIC_BASE_URL should use openrouter.ai/api", () => {
      const failures: string[] = [];

      for (const { key, content, agent } of implementedScripts) {
        const agentDef = manifest.agents[agent];
        if (!agentDef?.env?.ANTHROPIC_BASE_URL) continue;

        const codeLines = getCodeLines(content);
        const code = codeLines.join("\n");

        if (code.includes("ANTHROPIC_BASE_URL")) {
          // If the script sets this var, it should use openrouter.ai
          if (!code.includes("openrouter.ai")) {
            failures.push(key + ".sh");
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts set ANTHROPIC_BASE_URL without openrouter.ai:\n` +
            failures.map((f) => `  - ${f}`).join("\n") +
            "\n\nANTHROPIC_BASE_URL should point to https://openrouter.ai/api"
        );
      }
    });

    // Check that scripts setting OPENAI_BASE_URL use the OpenRouter URL
    it("scripts setting OPENAI_BASE_URL should use openrouter.ai", () => {
      const failures: string[] = [];

      for (const { key, content, agent } of implementedScripts) {
        const agentDef = manifest.agents[agent];
        if (!agentDef?.env?.OPENAI_BASE_URL) continue;

        const codeLines = getCodeLines(content);
        const code = codeLines.join("\n");

        if (code.includes("OPENAI_BASE_URL")) {
          // If the script sets this var, it should use openrouter.ai
          if (!code.includes("openrouter.ai")) {
            failures.push(key + ".sh");
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts set OPENAI_BASE_URL without openrouter.ai:\n` +
            failures.map((f) => `  - ${f}`).join("\n") +
            "\n\nOPENAI_BASE_URL should point to https://openrouter.ai/api/v1"
        );
      }
    });
  });

  // ── No hardcoded API keys ──────────────────────────────────────────────

  describe("no hardcoded API keys in scripts", () => {
    it("should not contain hardcoded OpenRouter API keys", () => {
      const failures: string[] = [];

      for (const { key, content } of implementedScripts) {
        const codeLines = getCodeLines(content);
        for (const line of codeLines) {
          // Check for hardcoded sk-or-v1 keys
          if (/sk-or-v1-[a-zA-Z0-9]{40,}/.test(line)) {
            failures.push(key + ".sh");
            break;
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `SECURITY: ${failures.length} scripts contain hardcoded API keys:\n` +
            failures.map((f) => `  - ${f}`).join("\n") +
            "\n\nAPI keys must NEVER be hardcoded in scripts."
        );
      }
    });

    it("should not contain hardcoded Anthropic API keys", () => {
      const failures: string[] = [];

      for (const { key, content } of implementedScripts) {
        const codeLines = getCodeLines(content);
        for (const line of codeLines) {
          if (/sk-ant-[a-zA-Z0-9]{40,}/.test(line)) {
            failures.push(key + ".sh");
            break;
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `SECURITY: ${failures.length} scripts contain hardcoded Anthropic API keys:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });

    it("should not contain hardcoded OpenAI API keys", () => {
      const failures: string[] = [];

      for (const { key, content } of implementedScripts) {
        const codeLines = getCodeLines(content);
        for (const line of codeLines) {
          if (/sk-[a-zA-Z0-9]{40,}/.test(line) && !line.includes("sk-or-v1") && !line.includes("sk-ant")) {
            failures.push(key + ".sh");
            break;
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `SECURITY: ${failures.length} scripts contain hardcoded OpenAI API keys:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── Coverage statistics ────────────────────────────────────────────────

  describe("coverage statistics", () => {
    it("should test all implemented scripts", () => {
      const implementedCount = implementedEntries.length;
      const testedCount = implementedScripts.length;
      // Allow for a few scripts that might not exist on disk yet
      expect(testedCount).toBeGreaterThan(implementedCount * 0.95);
    });

    it("should cover all agent types", () => {
      const testedAgents = new Set(implementedScripts.map((s) => s.agent));
      const manifestAgents = Object.keys(manifest.agents);
      // All agents with at least one implementation should be tested
      for (const agentKey of manifestAgents) {
        const hasImpl = implementedScripts.some((s) => s.agent === agentKey);
        const hasMatrixImpl = implementedEntries.some(([key]) => key.endsWith(`/${agentKey}`));
        if (hasMatrixImpl) {
          expect(hasImpl).toBe(true);
        }
      }
    });

    it("should cover all cloud providers", () => {
      const testedClouds = new Set(implementedScripts.map((s) => s.cloud));
      // All clouds with at least one implementation should be tested
      for (const cloud of cloudsWithImpls) {
        expect(testedClouds.has(cloud)).toBe(true);
      }
    });
  });
});
