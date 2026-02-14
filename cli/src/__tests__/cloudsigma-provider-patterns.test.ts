import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Pattern tests for the CloudSigma cloud provider.
 *
 * CloudSigma is a unique API-first cloud platform with:
 * - Region-based API URLs (https://{region}.cloudsigma.com/api/2.0)
 * - HTTP Basic Auth (CLOUDSIGMA_EMAIL + CLOUDSIGMA_PASSWORD)
 * - Drive cloning workflow (clone Ubuntu image, then attach to server)
 * - SSH-based exec using 'cloudsigma' user (not root)
 * - Granular resource control (CPU MHz, Memory bytes, Disk size)
 *
 * These tests validate:
 * 1. lib/common.sh defines the correct provider-specific API surface
 * 2. Agent scripts follow the correct provisioning flow
 * 3. Security conventions are enforced (region validation, python3 JSON, no echo -e)
 * 4. SSH delegation patterns use the correct 'cloudsigma' user
 * 5. Dual-credential handling (email + password) follows shared helper patterns
 * 6. OpenRouter env var injection uses SSH-based helpers
 * 7. Drive lifecycle (clone, attach) is correct
 * 8. Test infrastructure (mock.sh, record.sh) covers this provider
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

/** Extract the body of a named function from a shell script */
function extractFunctionBody(content: string, fnName: string): string {
  const lines = content.split("\n");
  let inFn = false;
  let braceDepth = 0;
  const body: string[] = [];

  for (const line of lines) {
    if (line.match(new RegExp(`^${fnName}\\(\\)`))) {
      inFn = true;
      continue;
    }
    if (inFn) {
      if (line.trim() === "{") { braceDepth++; continue; }
      if (line.trim() === "}") {
        braceDepth--;
        if (braceDepth <= 0) break;
      }
      body.push(line);
    }
  }
  return body.join("\n");
}

/** Collect implemented entries for CloudSigma */
function getImplementedEntries() {
  return Object.entries(manifest.matrix)
    .filter(([key, status]) => key.startsWith("cloudsigma/") && status === "implemented")
    .map(([key]) => {
      const agent = key.split("/")[1];
      return { key, agent, path: join(REPO_ROOT, key + ".sh") };
    })
    .filter(({ path }) => existsSync(path));
}

const cloudsigmaLibPath = join(REPO_ROOT, "cloudsigma", "lib", "common.sh");
const cloudsigmaLib = existsSync(cloudsigmaLibPath) ? readScript(cloudsigmaLibPath) : "";
const cloudsigmaFunctions = extractFunctions(cloudsigmaLib);
const cloudsigmaEntries = getImplementedEntries();

// ══════════════════════════════════════════════════════════════════════════════
// lib/common.sh API surface
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(cloudsigmaLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(cloudsigmaLib).toContain("shared/common.sh");
    expect(cloudsigmaLib).toContain("raw.githubusercontent.com");
    expect(cloudsigmaLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(cloudsigmaLib).toContain("set -eo pipefail");
  });

  // Required SSH-based cloud functions
  const requiredFunctions = [
    "create_server",
    "verify_server_connectivity",
    "run_server",
    "upload_file",
    "interactive_session",
    "get_server_name",
    "ensure_ssh_key",
  ];

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(cloudsigmaFunctions).toContain(fn);
    });
  }

  // CloudSigma-specific functions
  const providerSpecificFunctions = [
    "cloudsigma_api",
    "test_cloudsigma_credentials",
    "ensure_cloudsigma_credentials",
    "cloudsigma_check_ssh_key",
    "cloudsigma_register_ssh_key",
    "get_cloudsigma_api_base",
    "create_cloudsigma_drive",
    "_find_ubuntu_image_uuid",
    "_clone_drive",
    "_cloudsigma_build_server_body",
    "_wait_for_cloudsigma_server",
    "_resolve_cloudsigma_ip",
    "_get_ssh_key_uuid",
  ];

  for (const fn of providerSpecificFunctions) {
    it(`should define provider-specific ${fn}()`, () => {
      expect(cloudsigmaFunctions).toContain(fn);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// API base and region handling
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma API base URL and region handling", () => {
  it("should use region-based API URL pattern", () => {
    expect(cloudsigmaLib).toContain(".cloudsigma.com/api/");
  });

  it("should define default region as 'zrh' (Zurich)", () => {
    expect(cloudsigmaLib).toContain('CLOUDSIGMA_REGION_DEFAULT="zrh"');
  });

  it("should define API version as '2.0'", () => {
    expect(cloudsigmaLib).toContain('CLOUDSIGMA_API_VERSION="2.0"');
  });

  it("should allow region override via CLOUDSIGMA_REGION env var", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_REGION:-");
  });

  it("should validate region name to prevent SSRF attacks", () => {
    expect(cloudsigmaLib).toContain("validate_region_name");
  });

  it("should define configurable INSTANCE_STATUS_POLL_DELAY", () => {
    expect(cloudsigmaLib).toContain("INSTANCE_STATUS_POLL_DELAY");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Credential handling (dual-credential: email + password)
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma credential handling", () => {
  it("should use CLOUDSIGMA_EMAIL as the email env var", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_EMAIL");
  });

  it("should use CLOUDSIGMA_PASSWORD as the password env var", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_PASSWORD");
  });

  it("should use HTTP Basic Auth (base64 encoding)", () => {
    expect(cloudsigmaLib).toContain("Basic");
    expect(cloudsigmaLib).toContain("base64");
  });

  it("should use ensure_multi_credentials for dual-credential management", () => {
    expect(cloudsigmaLib).toContain("ensure_multi_credentials");
  });

  it("should pass provider name 'CloudSigma' to ensure_multi_credentials", () => {
    expect(cloudsigmaLib).toContain('"CloudSigma"');
  });

  it("should save credentials to ~/.config/spawn/cloudsigma.json", () => {
    expect(cloudsigmaLib).toContain("cloudsigma.json");
  });

  it("should test credentials by calling /balance/ endpoint", () => {
    expect(cloudsigmaLib).toContain('"/balance/"');
  });

  it("should check for 'balance' in credential test response", () => {
    expect(cloudsigmaLib).toContain('"balance"');
  });

  it("should show helpful error messages on credential validation failure", () => {
    expect(cloudsigmaLib).toContain("Verify credentials");
    expect(cloudsigmaLib).toContain("Ensure email and password are correct");
    expect(cloudsigmaLib).toContain("Check account is active");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH key management
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma SSH key management", () => {
  it("should use ensure_ssh_key_with_provider for SSH key lifecycle", () => {
    expect(cloudsigmaLib).toContain("ensure_ssh_key_with_provider");
  });

  it("should define check and register callbacks for SSH keys", () => {
    expect(cloudsigmaFunctions).toContain("cloudsigma_check_ssh_key");
    expect(cloudsigmaFunctions).toContain("cloudsigma_register_ssh_key");
  });

  it("should use /keypairs/ endpoint for SSH key operations", () => {
    expect(cloudsigmaLib).toContain('"/keypairs/"');
  });

  it("should use python3 for SSH key fingerprint comparison", () => {
    const checkBody = extractFunctionBody(cloudsigmaLib, "cloudsigma_check_ssh_key");
    expect(checkBody).toContain("python3");
    expect(checkBody).toContain("fingerprint");
  });

  it("should use python3 for safe JSON construction in key registration", () => {
    const registerBody = extractFunctionBody(cloudsigmaLib, "cloudsigma_register_ssh_key");
    expect(registerBody).toContain("python3");
    expect(registerBody).toContain("json.dumps");
  });

  it("should check for 'uuid' in register response to confirm success", () => {
    expect(cloudsigmaLib).toContain('"uuid"');
  });

  it("should show helpful error messages on SSH key registration failure", () => {
    expect(cloudsigmaLib).toContain("SSH key already registered");
    expect(cloudsigmaLib).toContain("Invalid SSH key format");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Drive lifecycle (CloudSigma-specific: clone Ubuntu image before server)
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma drive lifecycle", () => {
  it("should find Ubuntu image from library drives", () => {
    expect(cloudsigmaLib).toContain("/libdrives/");
    expect(cloudsigmaLib).toContain("ubuntu");
    expect(cloudsigmaLib).toContain("24.04");
  });

  it("should clone the library drive to create a disk", () => {
    expect(cloudsigmaLib).toContain("/action/?do=clone");
  });

  it("should use configurable disk size via CLOUDSIGMA_DISK_SIZE_GB", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_DISK_SIZE_GB");
  });

  it("should default to 20GB disk size", () => {
    expect(cloudsigmaLib).toContain(":-20");
  });

  it("should set CLOUDSIGMA_DRIVE_UUID after drive creation", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_DRIVE_UUID");
  });

  it("should use _extract_json_field for UUID extraction", () => {
    expect(cloudsigmaLib).toContain("_extract_json_field");
  });

  it("should show helpful error when Ubuntu image is not found", () => {
    expect(cloudsigmaLib).toContain("Could not find Ubuntu 24.04 image");
    expect(cloudsigmaLib).toContain("Try a different CLOUDSIGMA_REGION");
  });

  it("should show helpful error when drive cloning fails", () => {
    expect(cloudsigmaLib).toContain("Failed to clone drive");
    expect(cloudsigmaLib).toContain("Insufficient account balance or storage quota");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Server lifecycle
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma server lifecycle", () => {
  it("should create server via POST /servers/", () => {
    expect(cloudsigmaLib).toContain('"/servers/"');
    expect(cloudsigmaLib).toContain("POST");
  });

  it("should start server via POST /servers/{uuid}/action/?do=start", () => {
    expect(cloudsigmaLib).toContain("action/?do=start");
  });

  it("should use generic_wait_for_instance for polling server status", () => {
    expect(cloudsigmaLib).toContain("generic_wait_for_instance");
  });

  it("should wait for 'running' status", () => {
    expect(cloudsigmaLib).toContain('"running"');
  });

  it("should use configurable CPU via CLOUDSIGMA_CPU_MHZ", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_CPU_MHZ");
  });

  it("should default to 1000 MHz CPU", () => {
    expect(cloudsigmaLib).toContain(":-1000");
  });

  it("should use configurable memory via CLOUDSIGMA_MEMORY_GB", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_MEMORY_GB");
  });

  it("should default to 2GB memory", () => {
    expect(cloudsigmaLib).toContain(":-2");
  });

  it("should store server UUID in CLOUDSIGMA_SERVER_UUID", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_SERVER_UUID");
  });

  it("should store server IP in CLOUDSIGMA_SERVER_IP", () => {
    expect(cloudsigmaLib).toContain("CLOUDSIGMA_SERVER_IP");
  });

  it("should use python3 for safe JSON body construction", () => {
    // The build body function contains an inline Python script with json.dumps
    // We check the full lib since the function body extraction doesn't handle
    // nested braces from inline Python/JSON
    expect(cloudsigmaLib).toContain("_cloudsigma_build_server_body");
    expect(cloudsigmaLib).toContain("print(json.dumps(body))");
  });

  it("should attach drive and NIC to server body", () => {
    expect(cloudsigmaLib).toContain("'drives'");
    expect(cloudsigmaLib).toContain("'nics'");
  });

  it("should configure DHCP for IPv4", () => {
    expect(cloudsigmaLib).toContain("dhcp");
  });

  it("should use virtio device type for drive and NIC", () => {
    expect(cloudsigmaLib).toContain("virtio");
  });

  it("should generate random VNC password via openssl", () => {
    expect(cloudsigmaLib).toContain("openssl rand");
  });

  it("should resolve UUID-style IP references to actual IPs", () => {
    expect(cloudsigmaFunctions).toContain("_resolve_cloudsigma_ip");
    // UUID regex pattern for IP resolution
    expect(cloudsigmaLib).toContain("[0-9a-f]");
  });

  it("should show helpful error messages on server creation failure", () => {
    expect(cloudsigmaLib).toContain("Insufficient account balance");
    expect(cloudsigmaLib).toContain("Resource quota exceeded");
    expect(cloudsigmaLib).toContain("Region capacity limits reached");
  });

  it("should use get_validated_server_name for server name input", () => {
    expect(cloudsigmaLib).toContain("get_validated_server_name");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH delegation pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma SSH delegation pattern", () => {
  it("should set SSH_USER to 'cloudsigma' (not root)", () => {
    expect(cloudsigmaLib).toContain('SSH_USER="cloudsigma"');
  });

  it("should delegate verify_server_connectivity to ssh_verify_connectivity", () => {
    expect(cloudsigmaLib).toContain("ssh_verify_connectivity");
  });

  it("should delegate run_server to ssh_run_server", () => {
    expect(cloudsigmaLib).toContain("ssh_run_server");
  });

  it("should delegate upload_file to ssh_upload_file", () => {
    expect(cloudsigmaLib).toContain("ssh_upload_file");
  });

  it("should delegate interactive_session to ssh_interactive_session", () => {
    expect(cloudsigmaLib).toContain("ssh_interactive_session");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security conventions
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma security conventions", () => {
  it("should NOT contain echo -e (macOS compatibility)", () => {
    const codeLines = getCodeLines(cloudsigmaLib);
    const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
    expect(hasEchoE).toBe(false);
  });

  it("should NOT use set -u (nounset)", () => {
    const codeLines = getCodeLines(cloudsigmaLib);
    const hasSetU = codeLines.some(
      (l) => /\bset\s+.*-[a-z]*u/.test(l) || /\bset\s+-o\s+nounset\b/.test(l)
    );
    expect(hasSetU).toBe(false);
  });

  it("should validate CLOUDSIGMA_REGION to prevent SSRF", () => {
    expect(cloudsigmaLib).toContain("validate_region_name");
    // The security comment should explain why
    expect(cloudsigmaLib).toContain("SSRF");
  });

  it("should use python3 with json.dumps for all JSON construction (not string interpolation)", () => {
    // Every function that builds JSON should use python3 + json.dumps
    // We check the full lib for the presence of json.dumps near each function name
    // since inline Python with nested braces makes function body extraction unreliable
    const buildFunctions = ["_cloudsigma_build_server_body", "_clone_drive", "cloudsigma_register_ssh_key"];
    for (const fn of buildFunctions) {
      expect(cloudsigmaFunctions).toContain(fn);
    }
    // All JSON construction uses json.dumps (3 occurrences in the lib)
    const dumpCount = (cloudsigmaLib.match(/json\.dumps/g) || []).length;
    expect(dumpCount).toBeGreaterThanOrEqual(3);
  });

  it("should use extract_api_error_message for safe error display", () => {
    expect(cloudsigmaLib).toContain("extract_api_error_message");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent script patterns (common across all agents)
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma agent script patterns", () => {
  it("should have at least 6 implemented agent scripts", () => {
    expect(cloudsigmaEntries.length).toBeGreaterThanOrEqual(6);
  });

  for (const { key, agent, path } of cloudsigmaEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source cloudsigma/lib/common.sh with fallback", () => {
        expect(content).toContain("cloudsigma/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should use set -eo pipefail", () => {
        expect(content).toContain("set -eo pipefail");
      });

      it("should call ensure_cloudsigma_credentials", () => {
        expect(codeLines.some((l) => l.includes("ensure_cloudsigma_credentials"))).toBe(true);
      });

      it("should call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(true);
      });

      it("should call get_server_name and create_server", () => {
        expect(codeLines.some((l) => l.includes("get_server_name"))).toBe(true);
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call verify_server_connectivity with CLOUDSIGMA_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("verify_server_connectivity"))).toBe(true);
        expect(codeLines.some((l) => l.includes("CLOUDSIGMA_SERVER_IP"))).toBe(true);
      });

      it("should call wait_for_cloud_init with CLOUDSIGMA_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("wait_for_cloud_init"))).toBe(true);
        const waitLines = codeLines.filter((l) => l.includes("wait_for_cloud_init"));
        expect(waitLines.some((l) => l.includes("CLOUDSIGMA_SERVER_IP"))).toBe(true);
      });

      it("should reference OPENROUTER_API_KEY", () => {
        expect(codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))).toBe(true);
      });

      it("should handle OPENROUTER_API_KEY from env or OAuth", () => {
        expect(content).toContain("OPENROUTER_API_KEY:-");
        expect(content).toContain("get_openrouter_api_key_oauth");
      });

      it("should use inject_env_vars_ssh for env var injection (SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_ssh"))).toBe(true);
      });

      it("should NOT use inject_env_vars_local (CloudSigma is SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_local"))).toBe(false);
      });

      it("should pass CLOUDSIGMA_SERVER_IP to inject_env_vars_ssh", () => {
        const injectLines = codeLines.filter((l) => l.includes("inject_env_vars_ssh"));
        expect(injectLines.some((l) => l.includes("CLOUDSIGMA_SERVER_IP"))).toBe(true);
      });

      it("should call interactive_session with CLOUDSIGMA_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
        const sessionLines = codeLines.filter((l) => l.includes("interactive_session"));
        expect(sessionLines.some((l) => l.includes("CLOUDSIGMA_SERVER_IP"))).toBe(true);
      });

      it("should pass IP to run_server calls", () => {
        const runServerLines = codeLines.filter((l) => l.includes("run_server"));
        for (const line of runServerLines) {
          expect(line).toContain("CLOUDSIGMA_SERVER_IP");
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

describe("CloudSigma claude.sh agent-specific patterns", () => {
  const claudePath = join(REPO_ROOT, "cloudsigma", "claude.sh");
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

describe("CloudSigma aider.sh agent-specific patterns", () => {
  const aiderPath = join(REPO_ROOT, "cloudsigma", "aider.sh");
  const aiderExists = existsSync(aiderPath);
  const aiderContent = aiderExists ? readScript(aiderPath) : "";

  it("should exist", () => {
    expect(aiderExists).toBe(true);
  });

  it("should install aider via pip", () => {
    expect(aiderContent).toContain("aider-chat");
  });

  it("should set OPENAI_API_BASE for OpenRouter", () => {
    expect(aiderContent).toContain("OPENAI_API_BASE=https://openrouter.ai/api/v1");
  });

  it("should launch aider with openrouter model prefix", () => {
    expect(aiderContent).toContain("openrouter/");
  });
});

describe("CloudSigma codex.sh agent-specific patterns", () => {
  const codexPath = join(REPO_ROOT, "cloudsigma", "codex.sh");
  const codexExists = existsSync(codexPath);
  const codexContent = codexExists ? readScript(codexPath) : "";

  it("should exist", () => {
    expect(codexExists).toBe(true);
  });

  it("should install Node.js and Codex CLI", () => {
    expect(codexContent).toContain("nodejs");
    expect(codexContent).toContain("@openai/codex");
  });

  it("should set OPENAI_BASE_URL for OpenRouter", () => {
    expect(codexContent).toContain("OPENAI_BASE_URL=https://openrouter.ai/api/v1");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Manifest consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("Manifest consistency for CloudSigma", () => {
  it("cloudsigma should be in manifest.clouds", () => {
    expect(manifest.clouds["cloudsigma"]).toBeDefined();
  });

  it("cloudsigma should have type 'api'", () => {
    expect(manifest.clouds["cloudsigma"]?.type).toBe("api");
  });

  it("cloudsigma should mention CLOUDSIGMA_EMAIL and CLOUDSIGMA_PASSWORD in auth", () => {
    const auth = manifest.clouds["cloudsigma"]?.auth ?? "";
    expect(auth).toContain("CLOUDSIGMA_EMAIL");
    expect(auth).toContain("CLOUDSIGMA_PASSWORD");
  });

  it("cloudsigma should mention HTTP Basic Auth in auth field", () => {
    const auth = manifest.clouds["cloudsigma"]?.auth ?? "";
    expect(auth.toLowerCase()).toContain("basic auth");
  });

  it("cloudsigma should use SSH exec method with 'cloudsigma' user", () => {
    expect(manifest.clouds["cloudsigma"]?.exec_method).toContain("ssh");
    expect(manifest.clouds["cloudsigma"]?.exec_method).toContain("cloudsigma");
  });

  it("cloudsigma should use SSH interactive method with 'cloudsigma' user", () => {
    expect(manifest.clouds["cloudsigma"]?.interactive_method).toContain("ssh");
    expect(manifest.clouds["cloudsigma"]?.interactive_method).toContain("cloudsigma");
  });

  it("cloudsigma should have defaults for cpu, memory, disk, and region", () => {
    const cloud = manifest.clouds["cloudsigma"];
    expect(cloud?.defaults).toBeDefined();
    if (cloud?.defaults) {
      const defaults = cloud.defaults as Record<string, unknown>;
      expect(defaults.cpu_mhz).toBe(1000);
      expect(defaults.memory_gb).toBe(2);
      expect(defaults.disk_size_gb).toBe(20);
      expect(defaults.region).toBe("zrh");
    }
  });

  it("cloudsigma matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("cloudsigma/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("every cloudsigma/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix).filter(
      ([key, status]) => key.startsWith("cloudsigma/") && status === "implemented"
    );
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Test infrastructure coverage
// ══════════════════════════════════════════════════════════════════════════════

describe("CloudSigma test infrastructure", () => {
  const mockShPath = join(REPO_ROOT, "test", "mock.sh");
  const recordShPath = join(REPO_ROOT, "test", "record.sh");
  const mockSh = existsSync(mockShPath) ? readScript(mockShPath) : "";
  const recordSh = existsSync(recordShPath) ? readScript(recordShPath) : "";

  it("should be listed in test/mock.sh _strip_api_base", () => {
    expect(mockSh).toContain("cloudsigma.com");
  });

  it("should be listed in test/record.sh", () => {
    expect(recordSh).toContain("cloudsigma");
  });

  it("should have API base URL pattern in mock.sh", () => {
    expect(mockSh).toContain("cloudsigma.com/api/2.0");
  });

  it("should be in ALL_RECORDABLE_CLOUDS in record.sh", () => {
    const recordableMatch = recordSh.match(/ALL_RECORDABLE_CLOUDS="[^"]*"/);
    if (recordableMatch) {
      expect(recordableMatch[0]).toContain("cloudsigma");
    } else {
      expect(recordSh).toContain("cloudsigma");
    }
  });

  it("should have get_auth_env_var entry in record.sh", () => {
    // record.sh should map cloudsigma to CLOUDSIGMA_EMAIL
    expect(recordSh).toContain("CLOUDSIGMA_EMAIL");
  });

  it("should have a _live_cloudsigma function in record.sh", () => {
    expect(recordSh).toContain("_live_cloudsigma");
  });
});
