import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Tests for the mandatory OpenRouter injection requirement.
 *
 * CLAUDE.md states: "OpenRouter injection is mandatory. Every agent script MUST:
 *   - Set OPENROUTER_API_KEY in the shell environment
 *   - Set provider-specific env vars (e.g., ANTHROPIC_BASE_URL=https://openrouter.ai/api)
 *   - These come from the agent's `env` field in `manifest.json`"
 *
 * These tests validate that every implemented agent script on disk actually
 * references OpenRouter credentials and injects the env vars declared in the
 * manifest. This catches scripts that are "implemented" but would fail at
 * runtime because they don't set up the required API key plumbing.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const agents = Object.keys(manifest.agents);
const clouds = Object.keys(manifest.clouds);

// Collect all implemented entries with their script paths
const implementedEntries = Object.entries(manifest.matrix)
  .filter(([, status]) => status === "implemented")
  .map(([key]) => {
    const slashIdx = key.indexOf("/");
    return {
      key,
      cloud: key.substring(0, slashIdx),
      agent: key.substring(slashIdx + 1),
      path: join(REPO_ROOT, key + ".sh"),
    };
  })
  .filter(({ path }) => existsSync(path));

/** Read script content */
function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** Get non-comment, non-empty lines from a script */
function getActiveLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

describe("OpenRouter Injection (mandatory requirement)", () => {
  // ── OPENROUTER_API_KEY reference ──────────────────────────────────────

  describe("OPENROUTER_API_KEY reference in scripts", () => {
    it("should reference OPENROUTER_API_KEY in every implemented script", () => {
      const missing: string[] = [];

      for (const { key, path } of implementedEntries) {
        const content = readScript(path);
        // Scripts must reference OPENROUTER_API_KEY either directly or via
        // shared helper functions (get_openrouter_api_key, try_oauth_flow, etc.)
        const referencesOpenRouter =
          content.includes("OPENROUTER_API_KEY") ||
          content.includes("get_openrouter_api_key") ||
          content.includes("try_oauth_flow") ||
          content.includes("openrouter_api_key");

        if (!referencesOpenRouter) {
          missing.push(key + ".sh");
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `${missing.length} implemented scripts do not reference OPENROUTER_API_KEY:\n` +
            missing.map((f) => `  - ${f}`).join("\n") +
            `\n\nCLAUDE.md requires: "Every agent script MUST set OPENROUTER_API_KEY in the shell environment"`
        );
      }
    });

    it("should have a significant number of scripts to check", () => {
      expect(implementedEntries.length).toBeGreaterThan(100);
    });
  });

  // ── Agent env vars from manifest ─────────────────────────────────────

  describe("manifest env vars referenced in scripts", () => {
    // Group implemented entries by agent
    const agentScripts = new Map<string, typeof implementedEntries>();
    for (const entry of implementedEntries) {
      if (!agentScripts.has(entry.agent)) {
        agentScripts.set(entry.agent, []);
      }
      agentScripts.get(entry.agent)!.push(entry);
    }

    for (const [agentKey, scripts] of agentScripts) {
      const agentDef = manifest.agents[agentKey];
      if (!agentDef || !agentDef.env) continue;

      const envKeys = Object.keys(agentDef.env);
      if (envKeys.length === 0) continue;

      describe(`${agentKey} env vars`, () => {
        for (const envVar of envKeys) {
          it(`should reference ${envVar} in at least one ${agentKey} script`, () => {
            // At least one script for this agent should reference the env var.
            // The env var might be set in the script itself OR in lib/common.sh
            // (via shared setup functions), so we check the script and its
            // cloud's lib/common.sh.
            const found = scripts.some(({ path, cloud }) => {
              const scriptContent = readScript(path);
              if (scriptContent.includes(envVar)) return true;

              // Check the cloud's lib/common.sh too
              const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
              if (existsSync(libPath)) {
                const libContent = readScript(libPath);
                if (libContent.includes(envVar)) return true;
              }

              // Check shared/common.sh (setup functions reference env vars)
              const sharedPath = join(REPO_ROOT, "shared", "common.sh");
              if (existsSync(sharedPath)) {
                const sharedContent = readScript(sharedPath);
                if (sharedContent.includes(envVar)) return true;
              }

              return false;
            });

            expect(found).toBe(true);
          });
        }
      });
    }
  });

  // ── OpenRouter base URL or API endpoint ───────────────────────────────

  describe("OpenRouter API endpoint configuration", () => {
    it("should reference openrouter.ai in every implemented script (directly or via shared lib)", () => {
      const missing: string[] = [];

      for (const { key, path, cloud } of implementedEntries) {
        const content = readScript(path);

        // Check if the script references openrouter.ai directly
        let found = content.includes("openrouter.ai");

        // Or check if the cloud's lib/common.sh or shared/common.sh does
        if (!found) {
          const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
          if (existsSync(libPath)) {
            found = readFileSync(libPath, "utf-8").includes("openrouter.ai");
          }
        }
        if (!found) {
          const sharedPath = join(REPO_ROOT, "shared", "common.sh");
          if (existsSync(sharedPath)) {
            found = readFileSync(sharedPath, "utf-8").includes("openrouter.ai");
          }
        }

        if (!found) {
          missing.push(key + ".sh");
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `${missing.length} implemented scripts do not reference openrouter.ai anywhere in their chain:\n` +
            missing.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── Agent env field structural validation ─────────────────────────────

  describe("manifest agent env field structure", () => {
    it("should have non-empty env for every agent", () => {
      const emptyEnv: string[] = [];

      for (const [key, agent] of Object.entries(manifest.agents)) {
        if (!agent.env || Object.keys(agent.env).length === 0) {
          emptyEnv.push(key);
        }
      }

      if (emptyEnv.length > 0) {
        throw new Error(
          `${emptyEnv.length} agents have empty env field (must declare API key env vars):\n` +
            emptyEnv.map((k) => `  - ${k}`).join("\n")
        );
      }
    });

    it("should reference OPENROUTER_API_KEY in at least one env value per agent", () => {
      const missing: string[] = [];

      for (const [key, agent] of Object.entries(manifest.agents)) {
        if (!agent.env) {
          missing.push(key);
          continue;
        }

        const envValues = Object.values(agent.env);
        const hasOpenRouterRef = envValues.some(
          (v) =>
            v.includes("OPENROUTER_API_KEY") ||
            v.includes("$OPENROUTER_API_KEY") ||
            v === "OPENROUTER_API_KEY"
        );

        if (!hasOpenRouterRef) {
          missing.push(key);
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `${missing.length} agents don't reference OPENROUTER_API_KEY in their env values:\n` +
            missing.map((k) => `  - ${k} (env: ${JSON.stringify(manifest.agents[k].env)})`).join("\n") +
            `\n\nEvery agent must map at least one env var to $OPENROUTER_API_KEY`
        );
      }
    });

    it("should have env vars that look like valid environment variable names", () => {
      const invalid: string[] = [];

      for (const [key, agent] of Object.entries(manifest.agents)) {
        if (!agent.env) continue;

        for (const envKey of Object.keys(agent.env)) {
          // Env var names should be uppercase with underscores
          if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) {
            invalid.push(`${key}: ${envKey}`);
          }
        }
      }

      if (invalid.length > 0) {
        throw new Error(
          `${invalid.length} agent env keys don't look like valid env var names:\n` +
            invalid.map((k) => `  - ${k}`).join("\n")
        );
      }
    });
  });

  // ── Cross-reference: agent env vars vs script injection ───────────────

  describe("env var injection patterns in scripts", () => {
    it("should use export or env var assignment for API keys", () => {
      const noExport: string[] = [];

      for (const { key, path } of implementedEntries) {
        const content = readScript(path);
        const activeLines = getActiveLines(content);

        // Scripts should have at least one of:
        // - export SOME_API_KEY=...
        // - SOME_API_KEY=... (assignment)
        // - env SOME_API_KEY=... (inline env)
        // - Or use a shared function that does this (setup_*_config, inject_env_vars, etc.)
        const hasEnvInjection =
          activeLines.some((line) => /export\s+\w+.*=/.test(line)) ||
          activeLines.some((line) => /^\s*[A-Z][A-Z0-9_]*=/.test(line)) ||
          content.includes("setup_claude_code_config") ||
          content.includes("setup_openclaw_config") ||
          content.includes("setup_continue_config") ||
          content.includes("setup_nanoclaw_config") ||
          content.includes("setup_codex_config") ||
          content.includes("setup_gemini_config") ||
          content.includes("setup_interpreter_config") ||
          content.includes("inject_env") ||
          content.includes("bashrc") ||
          content.includes(".profile") ||
          content.includes("OPENROUTER_API_KEY");

        if (!hasEnvInjection) {
          noExport.push(key + ".sh");
        }
      }

      if (noExport.length > 0) {
        throw new Error(
          `${noExport.length} scripts don't appear to inject any env vars:\n` +
            noExport.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── Cloud lib/common.sh should support OpenRouter OAuth ───────────────

  describe("cloud lib/common.sh OpenRouter support", () => {
    const cloudsWithImpls = new Set<string>();
    for (const { cloud } of implementedEntries) {
      cloudsWithImpls.add(cloud);
    }

    it("should reference openrouter or oauth in every cloud lib/common.sh", () => {
      const missing: string[] = [];

      for (const cloud of cloudsWithImpls) {
        const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
        if (!existsSync(libPath)) continue;

        const content = readFileSync(libPath, "utf-8");
        // Cloud libs should either handle OpenRouter directly or source shared/common.sh
        // which provides the OAuth flow
        const hasOpenRouter =
          content.includes("openrouter") ||
          content.includes("OPENROUTER") ||
          content.includes("shared/common.sh");

        if (!hasOpenRouter) {
          missing.push(`${cloud}/lib/common.sh`);
        }
      }

      if (missing.length > 0) {
        throw new Error(
          `${missing.length} cloud libs don't reference OpenRouter or source shared/common.sh:\n` +
            missing.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── Consistency: every matrix entry for same agent injects same vars ──

  describe("consistent env injection across clouds for same agent", () => {
    // Group scripts by agent
    const byAgent = new Map<string, Array<{ cloud: string; path: string }>>();
    for (const { agent, cloud, path } of implementedEntries) {
      if (!byAgent.has(agent)) byAgent.set(agent, []);
      byAgent.get(agent)!.push({ cloud, path });
    }

    for (const [agent, scripts] of byAgent) {
      if (scripts.length < 2) continue;

      it(`should reference OPENROUTER_API_KEY consistently across all ${agent} scripts`, () => {
        const results = scripts.map(({ cloud, path }) => ({
          cloud,
          hasRef: readScript(path).includes("OPENROUTER_API_KEY") ||
                  readScript(path).includes("get_openrouter_api_key") ||
                  readScript(path).includes("try_oauth_flow") ||
                  readScript(path).includes("openrouter_api_key"),
        }));

        const allHaveRef = results.every((r) => r.hasRef);
        const noneHaveRef = results.every((r) => !r.hasRef);

        // Either all scripts should reference it or none should (meaning it's
        // handled entirely in shared libs). Mixed is suspicious.
        if (!allHaveRef && !noneHaveRef) {
          const withRef = results.filter((r) => r.hasRef).map((r) => r.cloud);
          const withoutRef = results.filter((r) => !r.hasRef).map((r) => r.cloud);
          // This is a warning-level check: inconsistency may be OK if some clouds
          // handle it differently, but it's worth flagging
          console.log(
            `[info] ${agent}: OPENROUTER_API_KEY referenced in ${withRef.join(", ")} ` +
              `but not in ${withoutRef.join(", ")}`
          );
        }
        // At minimum, ensure we didn't miss it everywhere
        expect(allHaveRef || noneHaveRef).toBe(true);
      });
    }
  });
});
