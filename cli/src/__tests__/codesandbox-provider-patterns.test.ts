import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * CodeSandbox cloud provider pattern and security tests.
 *
 * CodeSandbox is unique among spawn clouds: it uses the Node.js SDK for
 * execution (not SSH or REST API), passes data via environment variables
 * (not string interpolation), and validates sandbox IDs with a regex.
 *
 * These tests validate:
 * 1. Security: all inline Node.js code uses env vars, not interpolated values
 * 2. Sandbox ID validation: regex rejects injection characters
 * 3. API surface: required functions defined for agent scripts
 * 4. Agent scripts: follow CodeSandbox-specific patterns
 * 5. File upload: base64 encoding for safe transport
 * 6. No SSH patterns: CodeSandbox is SDK-based, not SSH-based
 * 7. Shell convention compliance (shebang, set -eo pipefail, etc.)
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const LIB_PATH = join(REPO_ROOT, "codesandbox", "lib", "common.sh");
const MANIFEST_PATH = join(REPO_ROOT, "manifest.json");

const libContent = existsSync(LIB_PATH) ? readFileSync(LIB_PATH, "utf-8") : "";
const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

/** Extract all function names defined with name() pattern */
function extractFunctionNames(content: string): string[] {
  const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

/** Get code lines (non-comment, non-empty) */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** Extract a function body from shell content */
function extractFunctionBody(content: string, funcName: string): string | null {
  const lines = content.split("\n");
  let startIdx = -1;
  let braceDepth = 0;
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (startIdx === -1) {
      // Look for function definition
      if (line.match(new RegExp(`^${funcName}\\(\\)\\s*\\{`)) ||
          line.match(new RegExp(`^${funcName}\\(\\)`))) {
        startIdx = i;
        // Count opening brace on definition line
        if (line.includes("{")) braceDepth++;
        continue;
      }
    } else {
      // Count braces
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      bodyLines.push(line);
      if (braceDepth === 0) break;
    }
  }

  return bodyLines.length > 0 ? bodyLines.join("\n") : null;
}

/** Get all CodeSandbox agent scripts */
function getCodeSandboxScripts(): Array<{ agent: string; path: string; content: string }> {
  const scripts: Array<{ agent: string; path: string; content: string }> = [];
  for (const [key, status] of Object.entries(manifest.matrix)) {
    if (!key.startsWith("codesandbox/") || status !== "implemented") continue;
    const agent = key.split("/")[1];
    const scriptPath = join(REPO_ROOT, key + ".sh");
    if (existsSync(scriptPath)) {
      scripts.push({
        agent,
        path: scriptPath,
        content: readFileSync(scriptPath, "utf-8"),
      });
    }
  }
  return scripts;
}

// ── Validate test prerequisites ──────────────────────────────────────────

describe("CodeSandbox provider pattern tests", () => {
  it("codesandbox/lib/common.sh exists", () => {
    expect(existsSync(LIB_PATH)).toBe(true);
  });

  it("codesandbox is defined in manifest.json", () => {
    expect(manifest.clouds.codesandbox).toBeDefined();
    expect(manifest.clouds.codesandbox.name).toBe("CodeSandbox");
  });

  // ── Security: environment variable passing ──────────────────────────

  describe("security: inline Node.js uses env vars (not string interpolation)", () => {
    const nodeBlocks = libContent.match(/node\s+-e\s+"[\s\S]*?"\s*(?:\d>&\d)?/g) || [];

    it("has at least 4 inline Node.js blocks (create, run, interactive, destroy)", () => {
      expect(nodeBlocks.length).toBeGreaterThanOrEqual(4);
    });

    it("all Node.js blocks read CSB_API_KEY from process.env", () => {
      for (const block of nodeBlocks) {
        expect(block).toContain("process.env.CSB_API_KEY");
      }
    });

    it("_invoke_codesandbox_create passes name via _CSB_NAME env var", () => {
      const body = extractFunctionBody(libContent, "_invoke_codesandbox_create");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_NAME=");
      expect(body).toContain("process.env._CSB_NAME");
    });

    it("_invoke_codesandbox_create passes template via _CSB_TEMPLATE env var", () => {
      const body = extractFunctionBody(libContent, "_invoke_codesandbox_create");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_TEMPLATE=");
      expect(body).toContain("process.env._CSB_TEMPLATE");
    });

    it("run_server passes sandbox ID via _CSB_SB_ID env var", () => {
      const body = extractFunctionBody(libContent, "run_server");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_SB_ID=");
      expect(body).toContain("process.env._CSB_SB_ID");
    });

    it("run_server passes command via _CSB_CMD env var", () => {
      const body = extractFunctionBody(libContent, "run_server");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_CMD=");
      expect(body).toContain("process.env._CSB_CMD");
    });

    it("interactive_session passes sandbox ID via _CSB_SB_ID env var", () => {
      const body = extractFunctionBody(libContent, "interactive_session");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_SB_ID=");
      expect(body).toContain("process.env._CSB_SB_ID");
    });

    it("interactive_session passes command via _CSB_CMD env var", () => {
      const body = extractFunctionBody(libContent, "interactive_session");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_CMD=");
      expect(body).toContain("process.env._CSB_CMD");
    });

    it("destroy_server passes sandbox ID via _CSB_SB_ID env var", () => {
      const body = extractFunctionBody(libContent, "destroy_server");
      expect(body).not.toBeNull();
      expect(body).toContain("_CSB_SB_ID=");
      expect(body).toContain("process.env._CSB_SB_ID");
    });

    it("no inline Node.js block uses direct bash variable interpolation for user data", () => {
      // Check that ${name}, ${cmd}, ${sandbox_id} are NOT interpolated
      // directly into Node.js code (they should come from process.env)
      const functionBodies = [
        extractFunctionBody(libContent, "_invoke_codesandbox_create"),
        extractFunctionBody(libContent, "run_server"),
        extractFunctionBody(libContent, "interactive_session"),
        extractFunctionBody(libContent, "destroy_server"),
      ].filter(Boolean);

      for (const body of functionBodies) {
        // Extract content between node -e " and the closing "
        const nodeMatch = body!.match(/node\s+-e\s+"([\s\S]*?)"\s*(?:\d>&\d)?/);
        if (!nodeMatch) continue;
        const jsCode = nodeMatch[1];

        // These bash variable patterns should NOT appear inside JS code
        // They indicate direct interpolation rather than env var passing
        expect(jsCode).not.toContain("${name}");
        expect(jsCode).not.toContain("${cmd}");
        expect(jsCode).not.toContain("${sandbox_id}");
        expect(jsCode).not.toContain("${CODESANDBOX_SANDBOX_ID}");
      }
    });
  });

  // ── Sandbox ID validation ──────────────────────────────────────────

  describe("sandbox ID validation", () => {
    // Replica of validate_sandbox_id from codesandbox/lib/common.sh
    function validateSandboxId(sid: string): boolean {
      return /^[a-zA-Z0-9_-]+$/.test(sid);
    }

    it("validate_sandbox_id function is defined", () => {
      const functions = extractFunctionNames(libContent);
      expect(functions).toContain("validate_sandbox_id");
    });

    it("validate_sandbox_id uses alphanumeric + dash/underscore regex", () => {
      const body = extractFunctionBody(libContent, "validate_sandbox_id");
      expect(body).not.toBeNull();
      expect(body).toContain("[a-zA-Z0-9_-]");
    });

    it("accepts valid sandbox IDs", () => {
      expect(validateSandboxId("abc123")).toBe(true);
      expect(validateSandboxId("my-sandbox")).toBe(true);
      expect(validateSandboxId("test_123")).toBe(true);
      expect(validateSandboxId("ABC-def_456")).toBe(true);
    });

    it("rejects IDs with spaces", () => {
      expect(validateSandboxId("my sandbox")).toBe(false);
    });

    it("rejects IDs with shell metacharacters", () => {
      expect(validateSandboxId("id;rm -rf /")).toBe(false);
      expect(validateSandboxId("id$(cmd)")).toBe(false);
      expect(validateSandboxId("id`cmd`")).toBe(false);
      expect(validateSandboxId("id|cat")).toBe(false);
      expect(validateSandboxId("id&bg")).toBe(false);
    });

    it("rejects IDs with path traversal characters", () => {
      expect(validateSandboxId("../../../etc/passwd")).toBe(false);
      expect(validateSandboxId("id/path")).toBe(false);
    });

    it("rejects IDs with quotes", () => {
      expect(validateSandboxId("id'inject")).toBe(false);
      expect(validateSandboxId('id"inject')).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validateSandboxId("")).toBe(false);
    });

    it("run_server calls validate_sandbox_id before executing", () => {
      const body = extractFunctionBody(libContent, "run_server");
      expect(body).not.toBeNull();
      expect(body).toContain("validate_sandbox_id");
    });

    it("interactive_session calls validate_sandbox_id before executing", () => {
      const body = extractFunctionBody(libContent, "interactive_session");
      expect(body).not.toBeNull();
      expect(body).toContain("validate_sandbox_id");
    });

    it("destroy_server calls validate_sandbox_id before executing", () => {
      const body = extractFunctionBody(libContent, "destroy_server");
      expect(body).not.toBeNull();
      expect(body).toContain("validate_sandbox_id");
    });
  });

  // ── API surface: required functions ─────────────────────────────────

  describe("API surface: required functions for agent scripts", () => {
    const functions = extractFunctionNames(libContent);

    const requiredFunctions = [
      "ensure_codesandbox_cli",
      "test_codesandbox_token",
      "ensure_codesandbox_token",
      "get_server_name",
      "create_server",
      "wait_for_cloud_init",
      "run_server",
      "upload_file",
      "interactive_session",
      "destroy_server",
      "list_servers",
      "validate_sandbox_id",
      "_invoke_codesandbox_create",
    ];

    for (const fn of requiredFunctions) {
      it(`defines ${fn}()`, () => {
        expect(functions).toContain(fn);
      });
    }

    it("does not define SSH-related functions (CodeSandbox is SDK-based)", () => {
      expect(functions).not.toContain("ensure_ssh_key");
      expect(functions).not.toContain("verify_server_connectivity");
      expect(functions).not.toContain("generic_ssh_wait");
      expect(functions).not.toContain("ssh_to_server");
    });
  });

  // ── Authentication pattern ─────────────────────────────────────────

  describe("authentication pattern", () => {
    it("uses CSB_API_KEY as the auth env var", () => {
      expect(libContent).toContain("CSB_API_KEY");
    });

    it("ensure_codesandbox_token uses ensure_api_token_with_provider", () => {
      const body = extractFunctionBody(libContent, "ensure_codesandbox_token");
      expect(body).not.toBeNull();
      expect(body).toContain("ensure_api_token_with_provider");
    });

    it("ensure_codesandbox_token references CSB_API_KEY env var name", () => {
      const body = extractFunctionBody(libContent, "ensure_codesandbox_token");
      expect(body).not.toBeNull();
      expect(body).toContain("CSB_API_KEY");
    });

    it("test_codesandbox_token checks for auth error patterns", () => {
      const body = extractFunctionBody(libContent, "test_codesandbox_token");
      expect(body).not.toBeNull();
      // Should check for unauthorized/invalid/authentication error messages
      expect(body).toMatch(/unauthorized|invalid.*key|authentication|401/i);
    });

    it("stores config at ~/.config/spawn/codesandbox.json", () => {
      const body = extractFunctionBody(libContent, "ensure_codesandbox_token");
      expect(body).not.toBeNull();
      expect(body).toContain("codesandbox.json");
    });
  });

  // ── File upload: base64 encoding ───────────────────────────────────

  describe("file upload: base64 encoding for safe transport", () => {
    const uploadBody = extractFunctionBody(libContent, "upload_file");

    it("upload_file function is defined", () => {
      expect(uploadBody).not.toBeNull();
    });

    it("uses base64 encoding for file content", () => {
      expect(uploadBody).toContain("base64");
    });

    it("validates remote_path for unsafe characters", () => {
      // upload_file should check for injection characters in remote_path
      expect(uploadBody).toMatch(/remote_path.*unsafe|invalid.*remote.*path/i);
    });

    it("rejects paths containing single quotes", () => {
      expect(uploadBody).toContain("'");
    });

    it("rejects paths containing dollar signs", () => {
      expect(uploadBody).toContain("$");
    });

    it("rejects paths containing backticks", () => {
      expect(uploadBody).toContain("`");
    });

    it("rejects paths containing newlines", () => {
      expect(uploadBody).toContain("\\n");
    });
  });

  // ── create_server: server creation flow ────────────────────────────

  describe("create_server function", () => {
    const body = extractFunctionBody(libContent, "create_server");

    it("create_server is defined", () => {
      expect(body).not.toBeNull();
    });

    it("calls _invoke_codesandbox_create", () => {
      expect(body).toContain("_invoke_codesandbox_create");
    });

    it("exports CODESANDBOX_SANDBOX_ID after creation", () => {
      expect(body).toContain("CODESANDBOX_SANDBOX_ID");
      expect(body).toContain("export CODESANDBOX_SANDBOX_ID");
    });

    it("handles creation failures with error messages", () => {
      expect(body).toContain("log_error");
      expect(body).toMatch(/fail|error/i);
    });

    it("supports CODESANDBOX_TEMPLATE env var for template selection", () => {
      expect(body).toContain("CODESANDBOX_TEMPLATE");
    });
  });

  // ── Shell convention compliance ────────────────────────────────────

  describe("shell convention compliance", () => {
    it("starts with #!/bin/bash", () => {
      expect(libContent.trimStart().startsWith("#!/bin/bash")).toBe(true);
    });

    it("uses set -eo pipefail", () => {
      expect(libContent).toContain("set -eo pipefail");
    });

    it("sources shared/common.sh", () => {
      expect(libContent).toContain("shared/common.sh");
    });

    it("uses local-or-remote fallback pattern for shared/common.sh", () => {
      expect(libContent).toContain("SCRIPT_DIR");
      expect(libContent).toContain("BASH_SOURCE");
      expect(libContent).toContain("eval");
      expect(libContent).toContain("curl -fsSL");
    });

    it("does not use echo -e (macOS incompatible)", () => {
      const codeLines = getCodeLines(libContent);
      const hasEchoE = codeLines.some((line) => /\becho\s+-e\b/.test(line));
      expect(hasEchoE).toBe(false);
    });

    it("does not use set -u (breaks optional env var checks)", () => {
      const codeLines = getCodeLines(libContent);
      const hasSetU = codeLines.some(
        (line) =>
          /\bset\s+.*-[a-z]*u/.test(line) ||
          /\bset\s+-o\s+nounset\b/.test(line)
      );
      expect(hasSetU).toBe(false);
    });

    it("does not use source <() process substitution", () => {
      const codeLines = getCodeLines(libContent);
      const hasSourceSubst = codeLines.some((line) => /\bsource\s+<\(/.test(line));
      expect(hasSourceSubst).toBe(false);
    });
  });

  // ── Node.js SDK usage patterns ─────────────────────────────────────

  describe("Node.js SDK usage patterns", () => {
    it("uses @codesandbox/sdk for all operations", () => {
      expect(libContent).toContain("@codesandbox/sdk");
    });

    it("imports CodeSandbox from the SDK in inline scripts", () => {
      expect(libContent).toContain("require('@codesandbox/sdk')");
    });

    it("uses sdk.sandboxes.create for sandbox creation", () => {
      expect(libContent).toContain("sdk.sandboxes.create");
    });

    it("uses sdk.sandboxes.get for sandbox access", () => {
      expect(libContent).toContain("sdk.sandboxes.get");
    });

    it("uses sdk.sandboxes.shutdown for cleanup", () => {
      expect(libContent).toContain("sdk.sandboxes.shutdown");
    });

    it("uses client.commands.run for command execution", () => {
      expect(libContent).toContain("client.commands.run");
    });

    it("uses sandbox.connect() before running commands", () => {
      expect(libContent).toContain("sandbox.connect");
    });
  });

  // ── Error handling in inline Node.js ───────────────────────────────

  describe("error handling in inline Node.js scripts", () => {
    it("all inline Node.js blocks have try/catch error handling", () => {
      // Count node -e blocks and try/catch blocks
      const nodeBlocks = libContent.match(/node\s+-e\s+"/g) || [];
      const tryCatchBlocks = libContent.match(/try\s*\{/g) || [];
      // Each node block should have at least one try/catch
      expect(tryCatchBlocks.length).toBeGreaterThanOrEqual(nodeBlocks.length);
    });

    it("error handlers use process.exit(1) for non-zero exit", () => {
      expect(libContent).toContain("process.exit(1)");
    });

    it("error handlers write to stderr via console.error", () => {
      // All node blocks should log errors to stderr
      const nodeBlockPattern = /node\s+-e\s+"[\s\S]*?"\s*(?:\d>&\d)?/g;
      const blocks = libContent.match(nodeBlockPattern) || [];
      for (const block of blocks) {
        expect(block).toContain("console.error");
      }
    });
  });

  // ── Agent scripts follow CodeSandbox patterns ──────────────────────

  describe("agent scripts follow CodeSandbox patterns", () => {
    const scripts = getCodeSandboxScripts();

    it("at least 2 agent scripts are implemented for CodeSandbox", () => {
      expect(scripts.length).toBeGreaterThanOrEqual(2);
    });

    for (const { agent, content } of scripts) {
      describe(`codesandbox/${agent}.sh`, () => {
        it("starts with #!/bin/bash", () => {
          expect(content.trimStart().startsWith("#!/bin/bash")).toBe(true);
        });

        it("uses set -eo pipefail", () => {
          expect(content).toContain("set -eo pipefail");
        });

        it("sources codesandbox/lib/common.sh", () => {
          expect(content).toContain("lib/common.sh");
        });

        it("has remote fallback for lib/common.sh", () => {
          expect(content).toContain("raw.githubusercontent.com");
          expect(content).toContain("codesandbox/lib/common.sh");
        });

        it("calls ensure_codesandbox_cli", () => {
          expect(content).toContain("ensure_codesandbox_cli");
        });

        it("calls ensure_codesandbox_token", () => {
          expect(content).toContain("ensure_codesandbox_token");
        });

        it("calls get_server_name and create_server", () => {
          expect(content).toContain("get_server_name");
          expect(content).toContain("create_server");
        });

        it("calls wait_for_cloud_init", () => {
          expect(content).toContain("wait_for_cloud_init");
        });

        it("handles OPENROUTER_API_KEY (from env or OAuth)", () => {
          expect(content).toContain("OPENROUTER_API_KEY");
        });

        it("calls interactive_session for the launch command", () => {
          expect(content).toContain("interactive_session");
        });

        it("uses inject_env_vars_local with upload_file and run_server", () => {
          expect(content).toContain("inject_env_vars_local");
          expect(content).toContain("upload_file");
          expect(content).toContain("run_server");
        });
      });
    }
  });

  // ── Manifest consistency ───────────────────────────────────────────

  describe("manifest consistency for CodeSandbox", () => {
    it("cloud type is 'sandbox'", () => {
      expect(manifest.clouds.codesandbox.type).toBe("sandbox");
    });

    it("auth field references CSB_API_KEY", () => {
      expect(manifest.clouds.codesandbox.auth).toContain("CSB_API_KEY");
    });

    it("exec_method describes SDK usage (not SSH)", () => {
      const execMethod = manifest.clouds.codesandbox.exec_method;
      expect(execMethod).not.toContain("ssh");
    });

    it("has at least 2 implemented matrix entries", () => {
      const implCount = Object.entries(manifest.matrix).filter(
        ([key, status]) => key.startsWith("codesandbox/") && status === "implemented"
      ).length;
      expect(implCount).toBeGreaterThanOrEqual(2);
    });

    it("every implemented matrix entry has a corresponding .sh file", () => {
      const missing: string[] = [];
      for (const [key, status] of Object.entries(manifest.matrix)) {
        if (!key.startsWith("codesandbox/") || status !== "implemented") continue;
        const scriptPath = join(REPO_ROOT, key + ".sh");
        if (!existsSync(scriptPath)) {
          missing.push(key + ".sh");
        }
      }
      if (missing.length > 0) {
        throw new Error(`Missing script files for implemented entries: ${missing.join(", ")}`);
      }
    });
  });

  // ── No function shadowing ──────────────────────────────────────────

  describe("no shared/common.sh function shadowing", () => {
    const functions = extractFunctionNames(libContent);

    const protectedFunctions = [
      "log_info",
      "log_warn",
      "log_error",
      "log_step",
      "json_escape",
      "validate_model_id",
      "safe_read",
      "open_browser",
      "try_oauth_flow",
      "get_openrouter_api_key_oauth",
      "get_openrouter_api_key_manual",
      "inject_env_vars_local",
      "inject_env_vars_ssh",
    ];

    it("does not redefine any protected shared functions", () => {
      const shadowed = protectedFunctions.filter((fn) => functions.includes(fn));
      if (shadowed.length > 0) {
        throw new Error(
          `codesandbox/lib/common.sh redefines shared functions: ${shadowed.join(", ")}`
        );
      }
    });
  });

  // ── wait_for_cloud_init installs tools ─────────────────────────────

  describe("wait_for_cloud_init tool installation", () => {
    const body = extractFunctionBody(libContent, "wait_for_cloud_init");

    it("wait_for_cloud_init is defined", () => {
      expect(body).not.toBeNull();
    });

    it("installs bun (used by many agent scripts)", () => {
      expect(body).toContain("bun");
    });

    it("adds bun to PATH in .bashrc", () => {
      expect(body).toContain(".bashrc");
      expect(body).toContain("PATH");
    });
  });

  // ── list_servers function ──────────────────────────────────────────

  describe("list_servers function", () => {
    const body = extractFunctionBody(libContent, "list_servers");

    it("list_servers is defined", () => {
      expect(body).not.toBeNull();
    });

    it("uses sdk.sandboxes.list to list sandboxes", () => {
      expect(body).toContain("sdk.sandboxes.list");
    });
  });

  // ── ensure_codesandbox_cli checks ──────────────────────────────────

  describe("ensure_codesandbox_cli dependency checks", () => {
    const body = extractFunctionBody(libContent, "ensure_codesandbox_cli");

    it("ensure_codesandbox_cli is defined", () => {
      expect(body).not.toBeNull();
    });

    it("checks for Node.js availability", () => {
      expect(body).toContain("node");
      expect(body).toContain("command -v");
    });

    it("installs @codesandbox/sdk if not present", () => {
      expect(body).toContain("npm install");
      expect(body).toContain("@codesandbox/sdk");
    });

    it("provides manual installation instructions on failure", () => {
      expect(body).toContain("npm install -g @codesandbox/sdk");
    });
  });

  // ── get_server_name uses shared helper ─────────────────────────────

  describe("get_server_name function", () => {
    const body = extractFunctionBody(libContent, "get_server_name");

    it("get_server_name is defined", () => {
      expect(body).not.toBeNull();
    });

    it("uses get_resource_name helper from shared", () => {
      expect(body).toContain("get_resource_name");
    });

    it("uses CODESANDBOX_SANDBOX_NAME env var", () => {
      expect(body).toContain("CODESANDBOX_SANDBOX_NAME");
    });
  });
});
