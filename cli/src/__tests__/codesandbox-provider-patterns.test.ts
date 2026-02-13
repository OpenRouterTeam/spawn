import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * CodeSandbox cloud provider pattern tests.
 *
 * CodeSandbox is a sandbox-based provider using Firecracker microVMs accessed
 * via the CodeSandbox SDK (no SSH). This test suite validates:
 *
 * 1. codesandbox/lib/common.sh defines the full sandbox API surface
 * 2. SDK interactions use environment variables for data passing (no injection)
 * 3. Sandbox ID validation rejects unsafe input
 * 4. upload_file uses base64 encoding and path validation
 * 5. Agent scripts follow the standard CodeSandbox provisioning flow
 * 6. Shell script conventions (shebang, set -eo pipefail, sourcing)
 * 7. OpenRouter env var injection is present in all agent scripts
 * 8. No SSH patterns leak into a sandbox-based provider
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

const libPath = join(REPO_ROOT, "codesandbox", "lib", "common.sh");
const libContent = existsSync(libPath) ? readFileSync(libPath, "utf-8") : "";
const libLines = libContent.split("\n");

// Collect implemented codesandbox/* matrix entries
const csbEntries = Object.entries(manifest.matrix)
  .filter(([key, status]) => key.startsWith("codesandbox/") && status === "implemented")
  .map(([key]) => {
    const agent = key.split("/")[1];
    return { key, agent, path: join(REPO_ROOT, key + ".sh") };
  })
  .filter(({ path }) => existsSync(path));

// Collect ALL codesandbox/* matrix entries (implemented + missing)
const allCsbEntries = Object.entries(manifest.matrix)
  .filter(([key]) => key.startsWith("codesandbox/"))
  .map(([key, status]) => ({ key, agent: key.split("/")[1], status }));

/** Read a script file */
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

/** Extract a function body by name (brace-depth tracking) */
function extractFunctionBody(content: string, funcName: string): string | null {
  const lines = content.split("\n");
  let startIdx = -1;
  let braceDepth = 0;
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (startIdx === -1) {
      if (trimmed.startsWith(`${funcName}()`) || trimmed === `${funcName}() {`) {
        startIdx = i;
        for (const ch of lines[i]) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }
        bodyLines.push(lines[i]);
        if (braceDepth <= 0 && startIdx >= 0) break;
        continue;
      }
    } else {
      for (const ch of lines[i]) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      bodyLines.push(lines[i]);
      if (braceDepth <= 0) break;
    }
  }

  return startIdx >= 0 ? bodyLines.join("\n") : null;
}

const definedFunctions = extractFunctions(libContent);

// ==============================================================
// Manifest integration
// ==============================================================

describe("CodeSandbox manifest entry", () => {
  it("should exist in manifest.clouds", () => {
    expect(manifest.clouds).toHaveProperty("codesandbox");
  });

  it("should have type 'sandbox'", () => {
    expect(manifest.clouds.codesandbox.type).toBe("sandbox");
  });

  it("should use CSB_API_KEY for auth", () => {
    expect(manifest.clouds.codesandbox.auth).toBe("CSB_API_KEY");
  });

  it("should use SDK for exec_method (not SSH)", () => {
    const exec = manifest.clouds.codesandbox.exec_method;
    expect(exec).not.toContain("ssh");
    expect(exec.toLowerCase()).toContain("sdk");
  });

  it("should have at least 3 implemented agent entries", () => {
    expect(csbEntries.length).toBeGreaterThanOrEqual(3);
  });

  it("should have matrix entries for all agents", () => {
    const agentKeys = Object.keys(manifest.agents);
    for (const agentKey of agentKeys) {
      const matrixKey = `codesandbox/${agentKey}`;
      expect(manifest.matrix).toHaveProperty(matrixKey);
    }
  });
});

// ==============================================================
// codesandbox/lib/common.sh API surface
// ==============================================================

describe("codesandbox/lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(libPath)).toBe(true);
  });

  it("should start with #!/bin/bash", () => {
    expect(libContent.trimStart()).toMatch(/^#!\/bin\/bash/);
  });

  it("should use set -eo pipefail", () => {
    expect(libContent).toContain("set -eo pipefail");
  });

  it("should source shared/common.sh", () => {
    expect(libContent).toContain("shared/common.sh");
  });

  it("should have remote fallback for shared/common.sh", () => {
    expect(libContent).toContain("raw.githubusercontent.com");
    expect(libContent).toContain("curl");
  });

  // Required functions for a sandbox provider
  const requiredFunctions = [
    "ensure_codesandbox_cli",
    "ensure_codesandbox_token",
    "get_server_name",
    "create_server",
    "wait_for_cloud_init",
    "run_server",
    "upload_file",
    "interactive_session",
    "destroy_server",
    "list_servers",
  ];

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(definedFunctions).toContain(fn);
    });
  }

  it("should define validate_sandbox_id() for input validation", () => {
    expect(definedFunctions).toContain("validate_sandbox_id");
  });

  it("should define test_codesandbox_token() for auth validation", () => {
    expect(definedFunctions).toContain("test_codesandbox_token");
  });

  it("should define _invoke_codesandbox_create() helper", () => {
    expect(definedFunctions).toContain("_invoke_codesandbox_create");
  });

  it("should NOT define SSH-related functions", () => {
    const sshFunctions = definedFunctions.filter(
      (fn) => fn.includes("ssh") || fn.includes("scp") || fn.includes("sftp")
    );
    expect(sshFunctions).toEqual([]);
  });

  it("should NOT contain any sshpass or ssh-keygen references in code lines", () => {
    const codeLines = getCodeLines(libContent);
    const sshRefs = codeLines.filter(
      (line) => line.includes("sshpass") || line.includes("ssh-keygen") || line.includes("ssh-copy-id")
    );
    expect(sshRefs).toEqual([]);
  });
});

// ==============================================================
// SDK security: environment variable data passing
// ==============================================================

describe("CodeSandbox SDK security: env var data passing", () => {
  // All SDK interactions should pass user data via environment variables,
  // never via string interpolation into Node.js code

  const sdkFunctions = [
    "_invoke_codesandbox_create",
    "run_server",
    "interactive_session",
    "destroy_server",
    "list_servers",
  ];

  for (const fn of sdkFunctions) {
    const body = extractFunctionBody(libContent, fn);
    if (!body) continue;

    it(`${fn}() should use 'node -e' for SDK calls`, () => {
      expect(body).toContain("node -e");
    });

    it(`${fn}() should pass CSB_API_KEY via environment`, () => {
      expect(body).toContain("CSB_API_KEY=");
      expect(body).toContain("process.env.CSB_API_KEY");
    });

    // Functions that take user input must pass it via env vars
    if (fn === "_invoke_codesandbox_create") {
      it(`${fn}() should pass sandbox name via _CSB_NAME env var`, () => {
        expect(body).toContain("_CSB_NAME=");
        expect(body).toContain("process.env._CSB_NAME");
      });

      it(`${fn}() should pass template via _CSB_TEMPLATE env var`, () => {
        expect(body).toContain("_CSB_TEMPLATE=");
        expect(body).toContain("process.env._CSB_TEMPLATE");
      });

      it(`${fn}() should NOT interpolate shell variables in Node.js code`, () => {
        // Check the node -e block does not have ${name} or ${template}
        const nodeBlock = body.substring(body.indexOf("node -e"));
        // The node -e "..." block should NOT contain ${name} or ${template}
        // (they should be accessed via process.env)
        const afterNodeE = nodeBlock.substring(nodeBlock.indexOf('"'));
        expect(afterNodeE).not.toMatch(/\$\{name\}/);
        expect(afterNodeE).not.toMatch(/\$\{template\}/);
      });
    }

    if (fn === "run_server" || fn === "interactive_session") {
      it(`${fn}() should pass sandbox ID via _CSB_SB_ID env var`, () => {
        expect(body).toContain("_CSB_SB_ID=");
        expect(body).toContain("process.env._CSB_SB_ID");
      });

      it(`${fn}() should pass command via _CSB_CMD env var`, () => {
        expect(body).toContain("_CSB_CMD=");
        expect(body).toContain("process.env._CSB_CMD");
      });
    }

    if (fn === "destroy_server") {
      it(`${fn}() should pass sandbox ID via _CSB_SB_ID env var`, () => {
        expect(body).toContain("_CSB_SB_ID=");
        expect(body).toContain("process.env._CSB_SB_ID");
      });
    }
  }

  it("SECURITY comment should exist on _invoke_codesandbox_create", () => {
    // Check the lines before the function definition
    const fnIdx = libLines.findIndex((l) => l.includes("_invoke_codesandbox_create()"));
    if (fnIdx > 0) {
      const precedingLines = libLines.slice(Math.max(0, fnIdx - 3), fnIdx).join("\n");
      expect(precedingLines).toContain("SECURITY");
    }
  });
});

// ==============================================================
// Sandbox ID validation
// ==============================================================

describe("validate_sandbox_id() patterns", () => {
  const body = extractFunctionBody(libContent, "validate_sandbox_id");

  it("should exist as a function", () => {
    expect(body).not.toBeNull();
  });

  it("should validate against a regex pattern", () => {
    expect(body!).toMatch(/=~/);
  });

  it("should accept only alphanumeric chars, dashes, and underscores", () => {
    // The regex should restrict to safe characters
    expect(body!).toContain("[a-zA-Z0-9_-]");
  });

  it("should return non-zero on invalid input", () => {
    expect(body!).toContain("return 1");
  });

  it("should log an error on invalid sandbox ID", () => {
    expect(body!).toContain("log_error");
  });

  it("should be called by run_server()", () => {
    const runServerBody = extractFunctionBody(libContent, "run_server");
    expect(runServerBody).toContain("validate_sandbox_id");
  });

  it("should be called by interactive_session()", () => {
    const interactiveBody = extractFunctionBody(libContent, "interactive_session");
    expect(interactiveBody).toContain("validate_sandbox_id");
  });

  it("should be called by destroy_server()", () => {
    const destroyBody = extractFunctionBody(libContent, "destroy_server");
    expect(destroyBody).toContain("validate_sandbox_id");
  });
});

// ==============================================================
// upload_file() security
// ==============================================================

describe("codesandbox upload_file() security", () => {
  const body = extractFunctionBody(libContent, "upload_file");

  it("should exist", () => {
    expect(body).not.toBeNull();
  });

  it("should validate remote_path against injection characters", () => {
    // Must reject single quotes, dollar signs, backticks, or newlines
    expect(body!).toContain(`"'"`);
    expect(body!).toMatch(/['"]\$['"]/);
  });

  it("should reject backtick characters in remote_path", () => {
    expect(body!).toContain("`");
  });

  it("should reject newlines in remote_path", () => {
    expect(body!).toMatch(/\\n/);
  });

  it("should base64-encode file content", () => {
    expect(body!).toContain("base64");
  });

  it("should use base64 -w0 or fallback for macOS compatibility", () => {
    // Linux uses base64 -w0, macOS base64 has no -w flag
    expect(body!).toContain("base64 -w0");
    // Should have fallback
    expect(body!).toContain("|| base64");
  });

  it("should decode base64 on the remote side", () => {
    expect(body!).toContain("base64 -d");
  });

  it("should use printf '%s' for safe content output", () => {
    expect(body!).toContain("printf '%s'");
  });

  it("should use escaped_path for safe path embedding", () => {
    expect(body!).toContain("escaped_path");
    expect(body!).toContain("printf '%q'");
  });

  it("should use run_server for remote execution", () => {
    expect(body!).toContain("run_server");
  });

  it("should return error on invalid remote path", () => {
    expect(body!).toContain("return 1");
  });
});

// ==============================================================
// ensure_codesandbox_token() and test_codesandbox_token()
// ==============================================================

describe("CodeSandbox authentication functions", () => {
  const ensureTokenBody = extractFunctionBody(libContent, "ensure_codesandbox_token");
  const testTokenBody = extractFunctionBody(libContent, "test_codesandbox_token");

  it("ensure_codesandbox_token should use ensure_api_token_with_provider", () => {
    expect(ensureTokenBody).toContain("ensure_api_token_with_provider");
  });

  it("ensure_codesandbox_token should specify CSB_API_KEY as the env var", () => {
    expect(ensureTokenBody).toContain("CSB_API_KEY");
  });

  it("ensure_codesandbox_token should specify config file path", () => {
    expect(ensureTokenBody).toContain("codesandbox.json");
  });

  it("ensure_codesandbox_token should provide API key URL for user guidance", () => {
    expect(ensureTokenBody).toContain("codesandbox.io");
  });

  it("ensure_codesandbox_token should pass test function name", () => {
    expect(ensureTokenBody).toContain("test_codesandbox_token");
  });

  it("test_codesandbox_token should check for unauthorized/401 errors", () => {
    expect(testTokenBody).toContain("unauthorized");
  });

  it("test_codesandbox_token should provide remediation steps on failure", () => {
    expect(testTokenBody).toContain("log_warn");
    expect(testTokenBody).toContain("Remediation");
  });

  it("test_codesandbox_token should return 1 on invalid key", () => {
    expect(testTokenBody).toContain("return 1");
  });
});

// ==============================================================
// create_server() and _invoke_codesandbox_create()
// ==============================================================

describe("CodeSandbox create_server() patterns", () => {
  const createBody = extractFunctionBody(libContent, "create_server");
  const invokeBody = extractFunctionBody(libContent, "_invoke_codesandbox_create");

  it("create_server should call _invoke_codesandbox_create", () => {
    expect(createBody).toContain("_invoke_codesandbox_create");
  });

  it("create_server should respect CODESANDBOX_TEMPLATE env var", () => {
    expect(createBody).toContain("CODESANDBOX_TEMPLATE");
  });

  it("create_server should export CODESANDBOX_SANDBOX_ID on success", () => {
    expect(createBody).toContain("CODESANDBOX_SANDBOX_ID");
    expect(createBody).toContain("export CODESANDBOX_SANDBOX_ID");
  });

  it("create_server should handle ERROR output gracefully", () => {
    expect(createBody).toContain("ERROR");
    expect(createBody).toContain("return 1");
  });

  it("create_server should log error details on failure", () => {
    expect(createBody).toContain("log_error");
  });

  it("_invoke_codesandbox_create should use @codesandbox/sdk", () => {
    expect(invokeBody).toContain("@codesandbox/sdk");
  });

  it("_invoke_codesandbox_create should output sandbox ID on success", () => {
    expect(invokeBody).toContain("console.log(sandbox.id)");
  });

  it("_invoke_codesandbox_create should exit non-zero on error", () => {
    expect(invokeBody).toContain("process.exit(1)");
  });
});

// ==============================================================
// destroy_server() patterns
// ==============================================================

describe("CodeSandbox destroy_server() patterns", () => {
  const body = extractFunctionBody(libContent, "destroy_server");

  it("should validate sandbox ID before shutdown", () => {
    expect(body).toContain("validate_sandbox_id");
  });

  it("should use SDK to shut down sandbox", () => {
    expect(body).toContain("sdk.sandboxes.shutdown");
  });

  it("should suppress errors with || true (graceful cleanup)", () => {
    expect(body).toContain("|| true");
  });

  it("should accept sandbox ID as parameter with fallback to global", () => {
    expect(body).toContain("CODESANDBOX_SANDBOX_ID");
  });
});

// ==============================================================
// ensure_codesandbox_cli() patterns
// ==============================================================

describe("CodeSandbox CLI installation", () => {
  const body = extractFunctionBody(libContent, "ensure_codesandbox_cli");

  it("should check for Node.js", () => {
    expect(body).toContain("command -v node");
  });

  it("should install @codesandbox/sdk globally", () => {
    expect(body).toContain("npm install -g @codesandbox/sdk");
  });

  it("should provide manual install instructions on failure", () => {
    expect(body).toContain("log_error");
    expect(body).toContain("npm install -g @codesandbox/sdk");
  });

  it("should handle missing curl gracefully", () => {
    expect(body).toContain("command -v curl");
  });

  it("should support Ubuntu/Debian, macOS, and Fedora install instructions", () => {
    expect(body).toContain("Ubuntu");
    expect(body).toContain("macOS");
    expect(body).toContain("Fedora");
  });
});

// ==============================================================
// wait_for_cloud_init() patterns
// ==============================================================

describe("CodeSandbox wait_for_cloud_init() patterns", () => {
  const body = extractFunctionBody(libContent, "wait_for_cloud_init");

  it("should install bun for the sandbox", () => {
    expect(body).toContain("bun.sh/install");
  });

  it("should add bun to PATH in bashrc", () => {
    expect(body).toContain(".bashrc");
    expect(body).toContain(".bun/bin");
  });

  it("should use run_server for remote commands", () => {
    expect(body).toContain("run_server");
  });
});

// ==============================================================
// Agent script patterns
// ==============================================================

describe("CodeSandbox agent scripts: standard provisioning flow", () => {
  for (const { key, agent, path } of csbEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      // -- Shell conventions --
      it("should start with #!/bin/bash", () => {
        expect(content.trimStart()).toMatch(/^#!\/bin\/bash/);
      });

      it("should use set -eo pipefail", () => {
        expect(content).toContain("set -eo pipefail");
      });

      // -- Source pattern --
      it("should source codesandbox/lib/common.sh (local or remote fallback)", () => {
        expect(content).toContain("lib/common.sh");
      });

      it("should have remote fallback for lib/common.sh", () => {
        expect(content).toContain("raw.githubusercontent.com");
        expect(content).toContain("codesandbox/lib/common.sh");
      });

      // -- Standard provisioning flow --
      it("should call ensure_codesandbox_cli", () => {
        expect(codeLines.some((l) => l.includes("ensure_codesandbox_cli"))).toBe(true);
      });

      it("should call ensure_codesandbox_token", () => {
        expect(codeLines.some((l) => l.includes("ensure_codesandbox_token"))).toBe(true);
      });

      it("should call get_server_name", () => {
        expect(codeLines.some((l) => l.includes("get_server_name"))).toBe(true);
      });

      it("should call create_server", () => {
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call wait_for_cloud_init", () => {
        expect(codeLines.some((l) => l.includes("wait_for_cloud_init"))).toBe(true);
      });

      // -- OpenRouter API key --
      it("should reference OPENROUTER_API_KEY", () => {
        expect(codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))).toBe(true);
      });

      it("should use get_openrouter_api_key_oauth or check env var", () => {
        const hasOAuth = content.includes("get_openrouter_api_key_oauth");
        const hasEnvCheck = content.includes("OPENROUTER_API_KEY:-");
        expect(hasOAuth || hasEnvCheck).toBe(true);
      });

      // -- Environment injection --
      it("should call inject_env_vars_local for sandbox env setup", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_local"))).toBe(true);
      });

      // -- Interactive session --
      it("should call interactive_session", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
      });

      // -- NO SSH patterns --
      it("should NOT use ssh, scp, or sftp commands", () => {
        const sshLines = codeLines.filter(
          (line) =>
            /\bssh\b/.test(line) || /\bscp\b/.test(line) || /\bsftp\b/.test(line)
        );
        expect(sshLines).toEqual([]);
      });

      it("should NOT use inject_env_vars_ssh", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_ssh"))).toBe(false);
      });

      it("should NOT reference SSH_KEY or SSH_OPTS", () => {
        const sshVarLines = codeLines.filter(
          (line) => line.includes("SSH_KEY") || line.includes("SSH_OPTS")
        );
        expect(sshVarLines).toEqual([]);
      });
    });
  }
});

// ==============================================================
// Agent-specific install steps
// ==============================================================

describe("CodeSandbox agent-specific installation", () => {
  for (const { key, agent, path } of csbEntries) {
    const content = readScript(path);
    const agentDef = manifest.agents[agent];
    if (!agentDef) continue;

    describe(`${key}.sh agent installation`, () => {
      it("should install the agent", () => {
        // Every agent script must have a "log_step" or "log_info" referencing install
        const hasInstallStep = content.includes("Install") || content.includes("install");
        expect(hasInstallStep).toBe(true);
      });

      it("should use run_server for remote installation commands", () => {
        const codeLines = getCodeLines(content);
        const runServerLines = codeLines.filter((l) => l.includes("run_server"));
        expect(runServerLines.length).toBeGreaterThanOrEqual(1);
      });

      // Check agent-specific env vars from manifest
      if (agentDef.env) {
        for (const [envVarName, envValue] of Object.entries(agentDef.env)) {
          // Skip empty-value env vars that are just unsets
          if (envValue === "") continue;
          // OPENROUTER_API_KEY is checked separately
          if (envVarName === "OPENROUTER_API_KEY") continue;

          it(`should reference ${envVarName} from agent env config`, () => {
            expect(content).toContain(envVarName);
          });
        }
      }
    });
  }
});

// ==============================================================
// Shell convention compliance (macOS bash 3.x)
// ==============================================================

describe("CodeSandbox scripts: macOS bash 3.x compatibility", () => {
  const allScripts = [
    { name: "lib/common.sh", path: libPath, content: libContent },
    ...csbEntries.map(({ key, path }) => ({
      name: `${key}.sh`,
      path,
      content: readScript(path),
    })),
  ];

  for (const { name, content } of allScripts) {
    const codeLines = getCodeLines(content);

    it(`${name} should NOT use echo -e`, () => {
      const echoELines = codeLines.filter((l) => /\becho\s+-e\b/.test(l));
      expect(echoELines).toEqual([]);
    });

    it(`${name} should NOT use source <(...)`, () => {
      const sourceSubLines = codeLines.filter((l) => /source\s+<\(/.test(l));
      expect(sourceSubLines).toEqual([]);
    });

    it(`${name} should NOT use set -u or set -o nounset`, () => {
      const setULines = codeLines.filter(
        (l) => /\bset\s+-[a-z]*u/.test(l) || l.includes("set -o nounset")
      );
      expect(setULines).toEqual([]);
    });

    it(`${name} should NOT use ((var++)) with set -e`, () => {
      const ppLines = codeLines.filter((l) => /\(\(\w+\+\+\)\)/.test(l));
      expect(ppLines).toEqual([]);
    });
  }
});

// ==============================================================
// Node.js SDK code quality in lib/common.sh
// ==============================================================

describe("CodeSandbox SDK Node.js code patterns", () => {
  // Check that each SDK-using function has proper Node.js patterns
  // by examining the function bodies (which contain the node -e blocks)
  const sdkFunctions = [
    "_invoke_codesandbox_create",
    "run_server",
    "interactive_session",
    "destroy_server",
    "list_servers",
  ];

  const sdkBodies = sdkFunctions
    .map((fn) => ({ fn, body: extractFunctionBody(libContent, fn) }))
    .filter((entry): entry is { fn: string; body: string } => entry.body !== null);

  it("should have SDK function bodies for all expected functions", () => {
    expect(sdkBodies.length).toBe(sdkFunctions.length);
  });

  for (const { fn, body } of sdkBodies) {
    it(`${fn}() should use @codesandbox/sdk`, () => {
      expect(body).toContain("@codesandbox/sdk");
    });

    it(`${fn}() should have error handling (try/catch)`, () => {
      expect(body).toContain("try");
      expect(body).toContain("catch");
    });

    it(`${fn}() should handle errors (process.exit or console.error)`, () => {
      // Most SDK functions exit on error; list_servers gracefully catches
      const hasProcessExit = body.includes("process.exit(1)");
      const hasConsoleError = body.includes("console.error");
      expect(hasProcessExit || hasConsoleError).toBe(true);
    });

    it(`${fn}() should use process.env for API key`, () => {
      expect(body).toContain("process.env.CSB_API_KEY");
    });
  }
});

// ==============================================================
// No dangerous patterns
// ==============================================================

describe("CodeSandbox lib: no dangerous patterns", () => {
  const codeLines = getCodeLines(libContent);

  it("should NOT use eval on user input", () => {
    const evalLines = codeLines.filter(
      (line) => /\beval\b/.test(line) && !line.includes("eval \"$(curl")
    );
    expect(evalLines).toEqual([]);
  });

  it("should NOT use unquoted variable expansions in commands", () => {
    // Check for $VAR (not "$VAR" or "${VAR}") in run_server calls
    // This is a simplified check - look for obvious unsafe patterns
    const unsafeLines = codeLines.filter(
      (line) => /run_server\s+\$[A-Z]/.test(line) && !line.includes('"')
    );
    expect(unsafeLines).toEqual([]);
  });

  it("should NOT embed user data directly in node -e code strings", () => {
    // Node -e blocks should not have ${cmd} or ${name} in the JS code
    // They should use process.env instead
    const nodeLines = codeLines.filter((l) => l.includes("node -e"));
    for (const line of nodeLines) {
      // After "node -e" there should be no ${} expansion inside the JS
      const jsStart = line.indexOf('node -e "');
      if (jsStart >= 0) {
        const jsCode = line.substring(jsStart + 9);
        // ${} inside JS code is OK for template literals, but not for bash vars
        // Bash vars would appear as ${name} not backtick template
        expect(jsCode).not.toMatch(/\$\{name\}/);
        expect(jsCode).not.toMatch(/\$\{cmd\}/);
        expect(jsCode).not.toMatch(/\$\{sandbox_id\}/);
      }
    }
  });

  it("should use SECURITY comments for security-critical sections", () => {
    const securityComments = libContent.split("\n").filter(
      (l) => l.includes("SECURITY")
    );
    expect(securityComments.length).toBeGreaterThanOrEqual(3);
  });
});

// ==============================================================
// get_server_name() and ensure_codesandbox_token() delegation
// ==============================================================

describe("CodeSandbox helper function delegation", () => {
  const getServerNameBody = extractFunctionBody(libContent, "get_server_name");

  it("get_server_name should use get_resource_name helper", () => {
    expect(getServerNameBody).toContain("get_resource_name");
  });

  it("get_server_name should use CODESANDBOX_SANDBOX_NAME env var", () => {
    expect(getServerNameBody).toContain("CODESANDBOX_SANDBOX_NAME");
  });
});

// ==============================================================
// list_servers() patterns
// ==============================================================

describe("CodeSandbox list_servers() patterns", () => {
  const body = extractFunctionBody(libContent, "list_servers");

  it("should use SDK to list sandboxes", () => {
    expect(body).toContain("sdk.sandboxes.list");
  });

  it("should output sandbox IDs", () => {
    expect(body).toContain("sb.id");
  });

  it("should handle errors gracefully", () => {
    expect(body).toContain("catch");
  });

  it("should have a fallback message when no sandboxes found", () => {
    expect(body).toContain("No sandboxes found");
  });
});

// ==============================================================
// Cross-check: existing test suites include CodeSandbox
// ==============================================================

describe("CodeSandbox should be covered by generic cloud test suites", () => {
  // Verify that CodeSandbox appears in the manifest's implemented entries
  // which means it gets picked up by the generic cloud-lib-api-surface and
  // cloud-lib-security-conventions test suites automatically

  it("should have at least one 'implemented' matrix entry", () => {
    const implemented = allCsbEntries.filter((e) => e.status === "implemented");
    expect(implemented.length).toBeGreaterThanOrEqual(1);
  });

  it("should be picked up by script-conventions.test.ts (via manifest)", () => {
    // This is a meta-check: if codesandbox has implemented entries, the
    // generic script-conventions tests will automatically include it
    const implementedKeys = csbEntries.map((e) => e.key);
    expect(implementedKeys.length).toBeGreaterThanOrEqual(3);
  });

  it("should have lib/common.sh for cloud-lib-api-surface tests", () => {
    expect(existsSync(libPath)).toBe(true);
  });
});
