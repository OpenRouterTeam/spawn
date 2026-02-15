import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Pattern tests for the Webdock cloud provider.
 *
 * Webdock is an SSH-based European VPS provider with:
 * - REST API (https://api.webdock.io/v1)
 * - Single API token auth (WEBDOCK_API_TOKEN)
 * - SSH-based exec (root@IP)
 * - generic_cloud_api + generic_wait_for_instance shared helpers
 *
 * These tests validate:
 * 1. lib/common.sh defines the correct provider-specific API surface
 * 2. Agent scripts follow the correct provisioning flow
 * 3. Security conventions are enforced (env var validation, json_escape)
 * 4. SSH delegation patterns are used correctly
 * 5. Credential handling follows shared helper patterns
 * 6. OpenRouter env var injection uses SSH-based helpers
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// ── Helpers ──────────────────────────────────────────────────────────────────

function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function extractFunctions(content: string): string[] {
  const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

/** Collect implemented entries for Webdock */
function getImplementedEntries() {
  return Object.entries(manifest.matrix)
    .filter(([key, status]) => key.startsWith("webdock/") && status === "implemented")
    .map(([key]) => {
      const agent = key.split("/")[1];
      return { key, agent, path: join(REPO_ROOT, key + ".sh") };
    })
    .filter(({ path }) => existsSync(path));
}

const webdockLibPath = join(REPO_ROOT, "webdock", "lib", "common.sh");
const webdockLib = existsSync(webdockLibPath) ? readScript(webdockLibPath) : "";
const webdockFunctions = extractFunctions(webdockLib);
const webdockEntries = getImplementedEntries();

// ══════════════════════════════════════════════════════════════════════════════
// lib/common.sh API surface
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(webdockLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(webdockLib).toContain("shared/common.sh");
    expect(webdockLib).toContain("raw.githubusercontent.com");
    expect(webdockLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(webdockLib).toContain("set -eo pipefail");
  });

  // Required SSH-based cloud functions
  const requiredFunctions = [
    "create_server",
    "destroy_server",
    "verify_server_connectivity",
    "run_server",
    "upload_file",
    "interactive_session",
    "get_server_name",
    "ensure_ssh_key",
  ];

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(webdockFunctions).toContain(fn);
    });
  }

  // Webdock-specific functions
  const providerSpecificFunctions = [
    "webdock_api",
    "test_webdock_token",
    "ensure_webdock_token",
    "webdock_check_ssh_key",
    "webdock_register_ssh_key",
    "list_servers",
    "_webdock_build_server_body",
    "_wait_for_webdock_server",
  ];

  for (const fn of providerSpecificFunctions) {
    it(`should define provider-specific ${fn}()`, () => {
      expect(webdockFunctions).toContain(fn);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// API base and constants
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock API base URL and constants", () => {
  it("should use the correct API base URL", () => {
    expect(webdockLib).toContain("https://api.webdock.io/v1");
  });

  it("should define a readonly WEBDOCK_API_BASE constant", () => {
    expect(webdockLib).toMatch(/readonly\s+WEBDOCK_API_BASE/);
  });

  it("should define configurable INSTANCE_STATUS_POLL_DELAY", () => {
    expect(webdockLib).toContain("INSTANCE_STATUS_POLL_DELAY");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Credential handling
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock credential handling", () => {
  it("should use WEBDOCK_API_TOKEN as the env var", () => {
    expect(webdockLib).toContain("WEBDOCK_API_TOKEN");
  });

  it("should use ensure_api_token_with_provider for token management", () => {
    expect(webdockLib).toContain("ensure_api_token_with_provider");
  });

  it("should pass provider name 'Webdock' to ensure_api_token_with_provider", () => {
    // ensure_webdock_token calls ensure_api_token_with_provider with "Webdock"
    // The call may span multiple lines with backslash continuation
    const lines = webdockLib.split("\n");
    let inEnsureToken = false;
    let foundWebdockArg = false;
    for (const line of lines) {
      if (line.match(/^ensure_webdock_token\(\)/)) inEnsureToken = true;
      if (inEnsureToken && line.includes('"Webdock"')) foundWebdockArg = true;
      if (inEnsureToken && line.match(/^}/)) break;
    }
    expect(foundWebdockArg).toBe(true);
  });

  it("should save credentials to ~/.config/spawn/webdock.json", () => {
    expect(webdockLib).toContain("webdock.json");
  });

  it("should point users to the correct account page", () => {
    expect(webdockLib).toContain("my.webdock.io/account");
  });

  it("should test token by calling /account endpoint", () => {
    expect(webdockLib).toContain('"/account"');
    expect(webdockLib).toContain('"email"');
  });

  it("should show helpful error messages on token validation failure", () => {
    expect(webdockLib).toContain("API & Integrations");
    expect(webdockLib).toContain("Generate a new API key");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH key management
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock SSH key management", () => {
  it("should use ensure_ssh_key_with_provider for SSH key lifecycle", () => {
    expect(webdockLib).toContain("ensure_ssh_key_with_provider");
  });

  it("should define check and register callbacks for SSH keys", () => {
    expect(webdockFunctions).toContain("webdock_check_ssh_key");
    expect(webdockFunctions).toContain("webdock_register_ssh_key");
  });

  it("should use check_ssh_key_by_fingerprint for key checking", () => {
    expect(webdockLib).toContain("check_ssh_key_by_fingerprint");
  });

  it("should use /account/publicKeys endpoint for SSH key operations", () => {
    expect(webdockLib).toContain('"/account/publicKeys"');
  });

  it("should use json_escape for SSH key registration (injection prevention)", () => {
    const registerFnLines = webdockLib.split("\n");
    let inRegisterFn = false;
    let usesJsonEscape = false;
    for (const line of registerFnLines) {
      if (line.match(/^webdock_register_ssh_key\(\)/)) inRegisterFn = true;
      if (inRegisterFn && line.includes("json_escape")) usesJsonEscape = true;
      if (inRegisterFn && line.match(/^}/)) break;
    }
    expect(usesJsonEscape).toBe(true);
  });

  it("should check for 'id' in register response to confirm success", () => {
    expect(webdockLib).toContain('"id"');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Server lifecycle
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock server lifecycle", () => {
  it("should use generic_cloud_api for API calls", () => {
    expect(webdockLib).toContain("generic_cloud_api");
  });

  it("should use generic_wait_for_instance for polling server status", () => {
    expect(webdockLib).toContain("generic_wait_for_instance");
  });

  it("should wait for 'online' status", () => {
    expect(webdockLib).toContain('"online"');
  });

  it("should extract IPv4 address from server response", () => {
    expect(webdockLib).toContain("d['ipv4']");
  });

  it("should store server IP in WEBDOCK_SERVER_IP", () => {
    expect(webdockLib).toContain("WEBDOCK_SERVER_IP");
  });

  it("should export WEBDOCK_SERVER_SLUG after server creation", () => {
    expect(webdockLib).toContain("export WEBDOCK_SERVER_SLUG");
  });

  it("should use python3 to build server creation body (safe JSON construction)", () => {
    const buildBodyLines = webdockLib.split("\n");
    let inBuildBody = false;
    let usesPython = false;
    for (const line of buildBodyLines) {
      if (line.match(/^_webdock_build_server_body\(\)/)) inBuildBody = true;
      if (inBuildBody && line.includes("python3")) usesPython = true;
      if (inBuildBody && line.match(/^}/)) break;
    }
    expect(usesPython).toBe(true);
  });

  it("should have sensible defaults for profile, location, and image", () => {
    expect(webdockLib).toContain("webdockmicro"); // default profile
    expect(webdockLib).toContain("ubuntu2404"); // default image
    // Default location is "fi" (Finland), referenced in ${WEBDOCK_LOCATION:-fi}
    expect(webdockLib).toContain(":-fi}"); // default location (Finland)
  });

  it("should validate env vars with validate_resource_name before server creation", () => {
    // Webdock uses _webdock_validate_inputs for validation
    expect(webdockLib).toContain("_webdock_validate_inputs");
    // Should be called early in create_server
    const createServerBody = webdockLib.split("\ncreate_server()")[1]?.split("\n}")[0] || "";
    expect(createServerBody).toContain("_webdock_validate_inputs");
  });

  it("should show helpful error messages on server creation failure", () => {
    expect(webdockLib).toContain("Insufficient account balance");
    expect(webdockLib).toContain("Slug already in use");
  });

  it("should use DELETE method for server destruction", () => {
    expect(webdockLib).toContain("DELETE");
    expect(webdockLib).toContain('"/servers/');
  });

  it("should use get_validated_server_name for server name input", () => {
    expect(webdockLib).toContain("get_validated_server_name");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH delegation pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock SSH delegation pattern", () => {
  it("should delegate verify_server_connectivity to ssh_verify_connectivity", () => {
    expect(webdockLib).toContain("ssh_verify_connectivity");
  });

  it("should delegate run_server to ssh_run_server", () => {
    expect(webdockLib).toContain("ssh_run_server");
  });

  it("should delegate upload_file to ssh_upload_file", () => {
    expect(webdockLib).toContain("ssh_upload_file");
  });

  it("should delegate interactive_session to ssh_interactive_session", () => {
    expect(webdockLib).toContain("ssh_interactive_session");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// list_servers
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock list_servers", () => {
  it("should query /servers endpoint", () => {
    const listLines = webdockLib.split("\n");
    let inList = false;
    let queriesServers = false;
    for (const line of listLines) {
      if (line.match(/^list_servers\(\)/)) inList = true;
      if (inList && line.includes('"/servers"')) queriesServers = true;
      if (inList && line.match(/^}/)) break;
    }
    expect(queriesServers).toBe(true);
  });

  it("should display name, slug, status, IP, and profile columns", () => {
    expect(webdockLib).toContain("NAME");
    expect(webdockLib).toContain("SLUG");
    expect(webdockLib).toContain("STATUS");
    expect(webdockLib).toContain("PROFILE");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security conventions
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock security conventions", () => {
  it("should NOT contain echo -e (macOS compatibility)", () => {
    const codeLines = getCodeLines(webdockLib);
    const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
    expect(hasEchoE).toBe(false);
  });

  it("should NOT use set -u (nounset)", () => {
    const codeLines = getCodeLines(webdockLib);
    const hasSetU = codeLines.some(
      (l) => /\bset\s+.*-[a-z]*u/.test(l) || /\bset\s+-o\s+nounset\b/.test(l)
    );
    expect(hasSetU).toBe(false);
  });

  it("should use json_escape for user-provided SSH key data", () => {
    expect(webdockLib).toContain("json_escape");
  });

  it("should use validate_resource_name for env var injection prevention", () => {
    expect(webdockLib).toContain("validate_resource_name");
  });

  it("should use extract_api_error_message for safe error display", () => {
    expect(webdockLib).toContain("extract_api_error_message");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent script patterns
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock agent script patterns", () => {
  it("should have at least 3 implemented agent scripts", () => {
    expect(webdockEntries.length).toBeGreaterThanOrEqual(3);
  });

  for (const { key, agent, path } of webdockEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source webdock/lib/common.sh with fallback", () => {
        expect(content).toContain("webdock/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should use set -eo pipefail", () => {
        expect(content).toContain("set -eo pipefail");
      });

      it("should call ensure_webdock_token", () => {
        expect(codeLines.some((l) => l.includes("ensure_webdock_token"))).toBe(true);
      });

      it("should call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(true);
      });

      it("should call get_server_name and create_server", () => {
        expect(codeLines.some((l) => l.includes("get_server_name"))).toBe(true);
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call verify_server_connectivity with WEBDOCK_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("verify_server_connectivity"))).toBe(true);
        expect(codeLines.some((l) => l.includes("WEBDOCK_SERVER_IP"))).toBe(true);
      });

      it("should call wait_for_cloud_init with WEBDOCK_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("wait_for_cloud_init"))).toBe(true);
        const waitLines = codeLines.filter((l) => l.includes("wait_for_cloud_init"));
        expect(waitLines.some((l) => l.includes("WEBDOCK_SERVER_IP"))).toBe(true);
      });

      it("should reference OPENROUTER_API_KEY", () => {
        expect(codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))).toBe(true);
      });

      it("should handle OPENROUTER_API_KEY from env or OAuth", () => {
        // Should check if key exists in env, otherwise fall back to OAuth
        expect(content).toContain("OPENROUTER_API_KEY:-");
        expect(content).toContain("get_openrouter_api_key_oauth");
      });

      it("should use inject_env_vars_ssh for env var injection (SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_ssh"))).toBe(true);
      });

      it("should NOT use inject_env_vars_local (Webdock is SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_local"))).toBe(false);
      });

      it("should pass WEBDOCK_SERVER_IP to inject_env_vars_ssh", () => {
        const injectLines = codeLines.filter((l) => l.includes("inject_env_vars_ssh"));
        expect(injectLines.some((l) => l.includes("WEBDOCK_SERVER_IP"))).toBe(true);
      });

      it("should call interactive_session with WEBDOCK_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
        const sessionLines = codeLines.filter((l) => l.includes("interactive_session"));
        expect(sessionLines.some((l) => l.includes("WEBDOCK_SERVER_IP"))).toBe(true);
      });

      it("should pass IP to run_server calls", () => {
        const runServerLines = codeLines.filter((l) => l.includes("run_server"));
        for (const line of runServerLines) {
          expect(line).toContain("WEBDOCK_SERVER_IP");
        }
      });

      it("should NOT contain any echo -e (macOS compat)", () => {
        const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
        expect(hasEchoE).toBe(false);
      });

      it("should NOT use set -u", () => {
        const hasSetU = codeLines.some(
          (l) => /\bset\s+.*-[a-z]*u/.test(l) || /\bset\s+-o\s+nounset\b/.test(l)
        );
        expect(hasSetU).toBe(false);
      });
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent-specific behavior
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock claude.sh agent-specific patterns", () => {
  const claudePath = join(REPO_ROOT, "webdock", "claude.sh");
  const claudeExists = existsSync(claudePath);
  const claudeContent = claudeExists ? readScript(claudePath) : "";

  it("should exist", () => {
    expect(claudeExists).toBe(true);
  });

  it("should install Claude Code if not present", () => {
    expect(claudeContent).toContain("claude.ai/install.sh");
  });

  it("should set ANTHROPIC_BASE_URL for OpenRouter", () => {
    expect(claudeContent).toContain("ANTHROPIC_BASE_URL=https://openrouter.ai/api");
  });

  it("should set CLAUDE_CODE_SKIP_ONBOARDING=1", () => {
    expect(claudeContent).toContain("CLAUDE_CODE_SKIP_ONBOARDING=1");
  });

  it("should set CLAUDE_CODE_ENABLE_TELEMETRY=0", () => {
    expect(claudeContent).toContain("CLAUDE_CODE_ENABLE_TELEMETRY=0");
  });

  it("should call setup_claude_code_config", () => {
    expect(claudeContent).toContain("setup_claude_code_config");
  });

  it("should launch claude in interactive session", () => {
    const codeLines = getCodeLines(claudeContent);
    const sessionLines = codeLines.filter((l) => l.includes("interactive_session"));
    expect(sessionLines.some((l) => l.includes("claude"))).toBe(true);
  });
});

describe("Webdock aider.sh agent-specific patterns", () => {
  const aiderPath = join(REPO_ROOT, "webdock", "aider.sh");
  const aiderExists = existsSync(aiderPath);
  const aiderContent = aiderExists ? readScript(aiderPath) : "";

  it("should exist", () => {
    expect(aiderExists).toBe(true);
  });

  it("should install aider via pip", () => {
    expect(aiderContent).toContain("pip install aider-chat");
  });

  it("should call get_model_id_interactive for model selection", () => {
    expect(aiderContent).toContain("get_model_id_interactive");
  });

  it("should launch aider with openrouter model prefix", () => {
    expect(aiderContent).toContain("openrouter/");
  });
});

describe("Webdock cline.sh agent-specific patterns", () => {
  const clinePath = join(REPO_ROOT, "webdock", "cline.sh");
  const clineExists = existsSync(clinePath);
  const clineContent = clineExists ? readScript(clinePath) : "";

  it("should exist", () => {
    expect(clineExists).toBe(true);
  });

  it("should install cline via npm", () => {
    expect(clineContent).toContain("npm install -g cline");
  });

  it("should set OPENAI_API_KEY and OPENAI_BASE_URL for OpenRouter", () => {
    expect(clineContent).toContain("OPENAI_API_KEY=");
    expect(clineContent).toContain("OPENAI_BASE_URL=https://openrouter.ai/api/v1");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Manifest consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("Manifest consistency for Webdock", () => {
  it("webdock should be in manifest.clouds", () => {
    expect(manifest.clouds["webdock"]).toBeDefined();
  });

  it("webdock should have type 'api'", () => {
    expect(manifest.clouds["webdock"]?.type).toBe("api");
  });

  it("webdock should have auth set to WEBDOCK_API_TOKEN", () => {
    expect(manifest.clouds["webdock"]?.auth).toBe("WEBDOCK_API_TOKEN");
  });

  it("webdock should use SSH exec method", () => {
    expect(manifest.clouds["webdock"]?.exec_method).toContain("ssh");
  });

  it("webdock should use SSH interactive method", () => {
    expect(manifest.clouds["webdock"]?.interactive_method).toContain("ssh");
  });

  it("webdock matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("webdock/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("every webdock/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix).filter(
      ([key, status]) => key.startsWith("webdock/") && status === "implemented"
    );
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });

  it("webdock should have defaults for profile, location, and image", () => {
    const cloud = manifest.clouds["webdock"];
    expect(cloud?.defaults).toBeDefined();
    if (cloud?.defaults) {
      expect(cloud.defaults.profile).toBe("webdockmicro");
      expect(cloud.defaults.location).toBe("fi");
      expect(cloud.defaults.image).toBe("ubuntu2404");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Test infrastructure coverage
// ══════════════════════════════════════════════════════════════════════════════

describe("Webdock test infrastructure", () => {
  const mockShPath = join(REPO_ROOT, "test", "mock.sh");
  const recordShPath = join(REPO_ROOT, "test", "record.sh");
  const mockSh = existsSync(mockShPath) ? readScript(mockShPath) : "";
  const recordSh = existsSync(recordShPath) ? readScript(recordShPath) : "";

  it("should be listed in test/mock.sh", () => {
    expect(mockSh).toContain("webdock");
  });

  it("should be listed in test/record.sh", () => {
    expect(recordSh).toContain("webdock");
  });

  it("should have API base URL pattern in mock.sh _strip_api_base", () => {
    // mock.sh should know how to strip https://api.webdock.io/v1
    expect(mockSh).toContain("api.webdock.io");
  });

  it("should be in ALL_RECORDABLE_CLOUDS in record.sh", () => {
    // The cloud should appear in the list of recordable clouds
    const recordableMatch = recordSh.match(/ALL_RECORDABLE_CLOUDS[^)]*\)/s);
    if (recordableMatch) {
      expect(recordableMatch[0]).toContain("webdock");
    } else {
      // If we can't find the array, at least verify webdock is referenced
      expect(recordSh).toContain("webdock");
    }
  });
});
