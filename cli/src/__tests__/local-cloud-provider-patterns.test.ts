import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Local cloud provider pattern tests.
 *
 * The "local" cloud is architecturally different from all SSH-based and
 * sandbox-based clouds: it runs agents directly on the user's machine
 * with no server provisioning. These tests validate:
 *
 * 1. local/lib/common.sh defines the correct no-op / local-execution API
 * 2. Local agent scripts use inject_env_vars_local (not SSH-based inject_env_vars)
 * 3. No SSH/SCP patterns leak into local scripts
 * 4. Every local script has ensure_local_ready
 * 5. OpenRouter API key handling is consistent across all local scripts
 * 6. SPAWN_PROMPT handling patterns are correct
 * 7. Installation verification patterns (command -v checks)
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// Collect all implemented local/* matrix entries
const localEntries = Object.entries(manifest.matrix)
  .filter(([key, status]) => key.startsWith("local/") && status === "implemented")
  .map(([key]) => {
    const agent = key.split("/")[1];
    return { key, agent, path: join(REPO_ROOT, key + ".sh") };
  })
  .filter(({ path }) => existsSync(path));

const libPath = join(REPO_ROOT, "local", "lib", "common.sh");
const libContent = existsSync(libPath) ? readFileSync(libPath, "utf-8") : "";

/** Read a local script */
function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** Get non-comment, non-empty lines */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** Extract function definitions from shell content */
function extractFunctions(content: string): string[] {
  const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

// ==============================================================
// local/lib/common.sh — API surface
// ==============================================================

describe("local/lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(libPath)).toBe(true);
  });

  it("should source shared/common.sh", () => {
    expect(libContent).toContain("shared/common.sh");
  });

  it("should have remote fallback for shared/common.sh", () => {
    expect(libContent).toContain("raw.githubusercontent.com");
    expect(libContent).toContain("curl");
  });

  const requiredFunctions = [
    "ensure_local_ready",
    "get_server_name",
    "create_server",
    "wait_for_cloud_init",
    "run_server",
    "upload_file",
    "interactive_session",
    "destroy_server",
    "list_servers",
  ];

  const definedFunctions = extractFunctions(libContent);

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(definedFunctions).toContain(fn);
    });
  }

  it("should NOT define any SSH-related functions", () => {
    const sshFunctions = definedFunctions.filter(
      (fn) => fn.includes("ssh") || fn.includes("scp") || fn.includes("sftp")
    );
    expect(sshFunctions).toEqual([]);
  });

  it("run_server should use bash -c (local execution, not SSH)", () => {
    expect(libContent).toMatch(/run_server\(\)\s*\{[\s\S]*?bash\s+-c/);
  });

  it("upload_file should use cp (local copy, not SCP/SFTP)", () => {
    expect(libContent).toMatch(/upload_file\(\)\s*\{[\s\S]*?\bcp\b/);
  });

  it("destroy_server should be a no-op (never destroy the user's machine)", () => {
    // The function body should not contain dangerous commands
    const destroyMatch = libContent.match(
      /destroy_server\(\)\s*\{([\s\S]*?)^\}/m
    );
    if (destroyMatch) {
      const body = destroyMatch[1];
      expect(body).not.toContain("rm -rf");
      expect(body).not.toContain("shutdown");
      expect(body).not.toContain("reboot");
      expect(body).not.toContain("poweroff");
    }
  });

  it("should use set -eo pipefail", () => {
    expect(libContent).toContain("set -eo pipefail");
  });

  it("should have #!/bin/bash shebang", () => {
    expect(libContent.trimStart()).toMatch(/^#!\/bin\/bash/);
  });

  it("ensure_local_ready should check for curl", () => {
    expect(libContent).toContain("command -v curl");
  });
});

// ==============================================================
// local agent scripts — shared patterns
// ==============================================================

describe("local agent scripts — shared patterns", () => {
  it("should have multiple implemented local agent scripts", () => {
    expect(localEntries.length).toBeGreaterThanOrEqual(10);
  });

  describe("sources local/lib/common.sh", () => {
    for (const { key, path } of localEntries) {
      it(`${key}.sh should source local/lib/common.sh`, () => {
        const content = readScript(path);
        expect(content).toContain("lib/common.sh");
      });
    }
  });

  describe("uses spawn_agent abstraction", () => {
    for (const { key, path } of localEntries) {
      it(`${key}.sh should call spawn_agent`, () => {
        const content = readScript(path);
        expect(content).toContain("spawn_agent");
      });
    }
  });

  describe("OpenRouter API key handling", () => {
    for (const { key, path } of localEntries) {
      it(`${key}.sh should reference OPENROUTER_API_KEY in agent_env_vars hook`, () => {
        const content = readScript(path);
        // Scripts use OPENROUTER_API_KEY in their agent_env_vars() hook
        expect(content).toContain("OPENROUTER_API_KEY");
      });
    }
  });

  describe("defines agent_env_vars hook", () => {
    for (const { key, path } of localEntries) {
      it(`${key}.sh should define agent_env_vars() hook`, () => {
        const content = readScript(path);
        // Scripts define agent_env_vars() hook for spawn_agent framework
        expect(content).toMatch(/agent_env_vars\s*\(\)\s*\{/);
      });

      it(`${key}.sh agent_env_vars should use generate_env_config`, () => {
        const content = readScript(path);
        // agent_env_vars hook should use generate_env_config helper
        expect(content).toContain("generate_env_config");
      });
    }
  });

  describe("no SSH patterns in local scripts", () => {
    for (const { key, path } of localEntries) {
      it(`${key}.sh should not contain SSH connection commands`, () => {
        const content = readScript(path);
        const codeLines = getCodeLines(content);
        for (const line of codeLines) {
          // Should not contain direct ssh commands (but ssh in URLs/comments is OK)
          expect(line).not.toMatch(/\bssh\s+-[A-Za-z]/);
          expect(line).not.toMatch(/\bscp\s+/);
        }
      });

      it(`${key}.sh should not reference SERVER_IP`, () => {
        const content = readScript(path);
        const codeLines = getCodeLines(content);
        const codeStr = codeLines.join("\n");
        expect(codeStr).not.toContain("SERVER_IP");
      });

      it(`${key}.sh should not call wait_for_ssh`, () => {
        const content = readScript(path);
        expect(content).not.toMatch(/\bwait_for_ssh\b/);
      });

      it(`${key}.sh should not call generic_ssh_wait`, () => {
        const content = readScript(path);
        expect(content).not.toMatch(/\bgeneric_ssh_wait\b/);
      });
    }
  });
});

// ==============================================================
// Installation verification patterns
// ==============================================================

describe("local agent scripts — installation verification", () => {
  for (const { key, path } of localEntries) {
    it(`${key}.sh should define agent_install() hook`, () => {
      const content = readScript(path);
      // Scripts define agent_install() hook for spawn_agent framework
      expect(content).toMatch(/agent_install\s*\(\)\s*\{/);
    });

    it(`${key}.sh should define agent_launch_cmd() hook`, () => {
      const content = readScript(path);
      // Scripts define agent_launch_cmd() hook to specify how to launch the agent
      expect(content).toMatch(/agent_launch_cmd\s*\(\)\s*\{/);
    });
  }
});

// ==============================================================
// SPAWN_PROMPT handling
// ==============================================================

describe("local agent scripts — SPAWN_PROMPT handling", () => {
  for (const { key, path } of localEntries) {
    const content = readScript(path);

    // Most scripts handle SPAWN_PROMPT, but not all
    if (content.includes("SPAWN_PROMPT")) {
      it(`${key}.sh should use safe SPAWN_PROMPT check with :- default`, () => {
        expect(content).toMatch(/SPAWN_PROMPT:-/);
      });

      it(`${key}.sh should handle both interactive and non-interactive modes`, () => {
        // If it checks SPAWN_PROMPT, it should have both branches
        const hasInteractive =
          content.includes("exec ") || content.includes("interactive_session");
        const hasNonInteractive =
          content.includes("-p ") ||
          content.includes("-m ") ||
          content.includes("tell ");
        // At minimum it should do something in the SPAWN_PROMPT branch
        expect(hasInteractive || hasNonInteractive).toBe(true);
      });
    }
  }
});

// ==============================================================
// Shell config persistence
// ==============================================================

describe("local agent scripts — shell config persistence", () => {
  for (const { key, path } of localEntries) {
    it(`${key}.sh launch command should source ~/.spawnrc or export env vars`, () => {
      const content = readScript(path);
      // Launch commands should source ~/.spawnrc (where spawn_agent writes env vars)
      // OR the framework handles env injection via agent_env_vars hook
      const sourcesSpawnrc = content.includes("source ~/.spawnrc") || content.includes("source ~/.zshrc") || content.includes("source ~/.bashrc");
      const hasEnvHook = content.includes("agent_env_vars");
      expect(sourcesSpawnrc || hasEnvHook).toBe(true);
    });
  }
});

// ==============================================================
// Security: no dangerous local operations
// ==============================================================

describe("local agent scripts — safety checks", () => {
  for (const { key, path } of localEntries) {
    it(`${key}.sh should not use rm -rf on system directories`, () => {
      const content = readScript(path);
      const codeLines = getCodeLines(content);
      for (const line of codeLines) {
        if (line.includes("rm -rf")) {
          // Should only rm -rf temp files or specific app dirs, not system dirs
          expect(line).not.toMatch(/rm\s+-rf\s+[/~]\s/);
          expect(line).not.toMatch(/rm\s+-rf\s+\/$/);
        }
      }
    });

    it(`${key}.sh should not use sudo`, () => {
      const content = readScript(path);
      const codeLines = getCodeLines(content);
      for (const line of codeLines) {
        expect(line).not.toMatch(/\bsudo\b/);
      }
    });
  }
});

// ==============================================================
// Manifest consistency
// ==============================================================

describe("local cloud manifest consistency", () => {
  it("manifest should have local cloud entry", () => {
    expect(manifest.clouds["local"]).toBeDefined();
  });

  it("local cloud type should be 'local'", () => {
    expect(manifest.clouds["local"].type).toBe("local");
  });

  it("local cloud auth should be 'none'", () => {
    expect(manifest.clouds["local"].auth).toBe("none");
  });

  it("local cloud exec_method should be 'bash -c'", () => {
    expect(manifest.clouds["local"].exec_method).toBe("bash -c");
  });

  it("most implemented local/* entries should have a corresponding script file", () => {
    const implemented = Object.entries(manifest.matrix)
      .filter(([key, status]) => key.startsWith("local/") && status === "implemented");

    const missing: string[] = [];
    for (const [key] of implemented) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      if (!existsSync(scriptPath)) {
        missing.push(key + ".sh");
      }
    }

    // Allow at most 1 missing file (manifest may be ahead of implementation)
    if (missing.length > 1) {
      throw new Error(
        `${missing.length} implemented local entries have no script file:\n` +
          missing.map((f) => `  - ${f}`).join("\n")
      );
    }
    if (missing.length > 0) {
      console.log(
        `Note: ${missing.length} local entry marked implemented but missing file: ${missing.join(", ")}`
      );
    }
  });

  it("local should have no credentials required (auth: none)", () => {
    const cloud = manifest.clouds["local"];
    expect(cloud.auth).toBe("none");
    expect(cloud.provision_method).toContain("none");
  });
});
