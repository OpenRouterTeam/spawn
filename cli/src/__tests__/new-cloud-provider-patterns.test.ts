import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Pattern tests for recently added cloud providers: Atlantic.Net and CodeSandbox.
 *
 * These two clouds use architecturally distinct patterns:
 *
 * - Atlantic.Net: HMAC-SHA256 signed REST API, query-parameter-based calls,
 *   SSH-based exec, dual-credential auth (API key + private key)
 * - CodeSandbox: Node.js SDK-based exec (no SSH), sandbox microVMs,
 *   single API token auth, environment-variable-based injection for SDK calls
 *
 * These tests validate:
 * 1. lib/common.sh defines the correct provider-specific API surface
 * 2. Agent scripts follow the correct provisioning flow for each provider
 * 3. Security conventions are enforced (env var passing, no string interpolation)
 * 4. SSH vs SDK exec patterns are used correctly per provider
 * 5. Credential handling follows the shared helper patterns
 * 6. OpenRouter env var injection uses the correct helper (SSH vs local)
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

/** Collect implemented entries for a given cloud */
function getImplementedEntries(cloud: string) {
  return Object.entries(manifest.matrix)
    .filter(([key, status]) => key.startsWith(`${cloud}/`) && status === "implemented")
    .map(([key]) => {
      const agent = key.split("/")[1];
      return { key, agent, path: join(REPO_ROOT, key + ".sh") };
    })
    .filter(({ path }) => existsSync(path));
}

// ══════════════════════════════════════════════════════════════════════════════
// Atlantic.Net
// ══════════════════════════════════════════════════════════════════════════════

const atlanticnetLibPath = join(REPO_ROOT, "atlanticnet", "lib", "common.sh");
const atlanticnetLib = existsSync(atlanticnetLibPath)
  ? readScript(atlanticnetLibPath)
  : "";
const atlanticnetFunctions = extractFunctions(atlanticnetLib);
const atlanticnetEntries = getImplementedEntries("atlanticnet");

describe("Atlantic.Net lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(atlanticnetLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(atlanticnetLib).toContain("shared/common.sh");
    expect(atlanticnetLib).toContain("raw.githubusercontent.com");
    expect(atlanticnetLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(atlanticnetLib).toContain("set -eo pipefail");
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
      expect(atlanticnetFunctions).toContain(fn);
    });
  }

  // Atlantic.Net-specific functions
  const providerSpecificFunctions = [
    "atlanticnet_api",
    "atlanticnet_sign",
    "atlanticnet_generate_guid",
    "atlanticnet_check_ssh_key",
    "atlanticnet_register_ssh_key",
    "ensure_atlanticnet_credentials",
    "test_atlanticnet_credentials",
    "get_plan_name",
    "get_image_id",
    "get_location",
    "url_encode",
  ];

  for (const fn of providerSpecificFunctions) {
    it(`should define provider-specific ${fn}()`, () => {
      expect(atlanticnetFunctions).toContain(fn);
    });
  }
});

describe("Atlantic.Net HMAC-SHA256 signing pattern", () => {
  it("should use openssl dgst for signature generation", () => {
    expect(atlanticnetLib).toContain("openssl dgst -sha256 -hmac");
  });

  it("should use base64 encoding for signature", () => {
    expect(atlanticnetLib).toContain("| base64");
  });

  it("should generate UUID for request deduplication", () => {
    expect(atlanticnetLib).toContain("uuid.uuid4");
  });

  it("should include required query parameters in API calls", () => {
    const codeLines = getCodeLines(atlanticnetLib);
    const apiBody = codeLines.join("\n");
    expect(apiBody).toContain("Action=");
    expect(apiBody).toContain("Format=json");
    expect(apiBody).toContain("ACSAccessKeyId");
    expect(apiBody).toContain("Timestamp");
    expect(apiBody).toContain("Signature");
    expect(apiBody).toContain("Rndguid");
  });

  it("should URL-encode the signature", () => {
    expect(atlanticnetLib).toContain("url_encode");
    // url_encode uses python3 urllib.parse.quote
    expect(atlanticnetLib).toContain("urllib.parse.quote");
  });
});

describe("Atlantic.Net API base URL and version", () => {
  it("should use the correct API base URL", () => {
    expect(atlanticnetLib).toContain("https://cloudapi.atlantic.net");
  });

  it("should define a readonly API version constant", () => {
    expect(atlanticnetLib).toContain("ATLANTICNET_API_VERSION");
    expect(atlanticnetLib).toContain("2010-12-30");
  });

  it("should define a readonly API base constant", () => {
    expect(atlanticnetLib).toContain("ATLANTICNET_API_BASE");
    expect(atlanticnetLib).toMatch(/readonly\s+ATLANTICNET_API_BASE/);
  });
});

describe("Atlantic.Net credential handling", () => {
  it("should require both API key and private key", () => {
    expect(atlanticnetLib).toContain("ATLANTICNET_API_KEY");
    expect(atlanticnetLib).toContain("ATLANTICNET_API_PRIVATE_KEY");
  });

  it("should use ensure_multi_credentials for dual-credential management", () => {
    // Atlantic.Net uses ensure_multi_credentials (shared helper) for the
    // env var -> config file -> prompt flow with dual credentials
    expect(atlanticnetLib).toContain("ensure_multi_credentials");
  });

  it("should pass both credential specs to ensure_multi_credentials", () => {
    // Both ATLANTICNET_API_KEY and ATLANTICNET_API_PRIVATE_KEY with their config field names
    expect(atlanticnetLib).toContain("ATLANTICNET_API_KEY:api_key");
    expect(atlanticnetLib).toContain("ATLANTICNET_API_PRIVATE_KEY:api_private_key");
  });

  it("should reference the config file path for credential storage", () => {
    expect(atlanticnetLib).toContain(".config/spawn/atlanticnet.json");
  });

  it("should test credentials before accepting them", () => {
    expect(atlanticnetFunctions).toContain("test_atlanticnet_credentials");
    // The test function calls the API to verify
    expect(atlanticnetLib).toContain("describe-plan");
  });
});

describe("Atlantic.Net SSH key management", () => {
  it("should use ensure_ssh_key_with_provider for SSH key lifecycle", () => {
    expect(atlanticnetLib).toContain("ensure_ssh_key_with_provider");
  });

  it("should define check and register callbacks for SSH keys", () => {
    expect(atlanticnetFunctions).toContain("atlanticnet_check_ssh_key");
    expect(atlanticnetFunctions).toContain("atlanticnet_register_ssh_key");
  });

  it("should use list-sshkeys API action to check SSH keys", () => {
    expect(atlanticnetLib).toContain("list-sshkeys");
  });

  it("should use add-sshkey API action to register SSH keys", () => {
    expect(atlanticnetLib).toContain("add-sshkey");
  });
});

describe("Atlantic.Net server lifecycle", () => {
  it("should use run-instance API action to create servers", () => {
    expect(atlanticnetLib).toContain("run-instance");
  });

  it("should use terminate-instance API action to destroy servers", () => {
    expect(atlanticnetLib).toContain("terminate-instance");
  });

  it("should extract instance ID from API response using python3", () => {
    expect(atlanticnetLib).toContain("instanceid");
    expect(atlanticnetLib).toContain("run-instanceresponse");
  });

  it("should extract IP address from API response using python3", () => {
    expect(atlanticnetLib).toContain("ip_address");
  });

  it("should export ATLANTICNET_SERVER_ID and ATLANTICNET_SERVER_IP", () => {
    // Both exported on the same line
    expect(atlanticnetLib).toContain("export ATLANTICNET_SERVER_ID ATLANTICNET_SERVER_IP");
  });

  it("should have sensible defaults for plan, image, and location", () => {
    expect(atlanticnetLib).toContain("G2.2GB"); // default plan
    expect(atlanticnetLib).toContain("ubuntu-24.04_64bit"); // default image
    expect(atlanticnetLib).toContain("USEAST2"); // default location
  });
});

describe("Atlantic.Net SSH delegation pattern", () => {
  it("should delegate SSH operations to shared helpers", () => {
    // Atlantic.Net delegates to ssh_* helpers from shared/common.sh
    expect(atlanticnetLib).toContain("ssh_verify_connectivity");
    expect(atlanticnetLib).toContain("ssh_run_server");
    expect(atlanticnetLib).toContain("ssh_upload_file");
    expect(atlanticnetLib).toContain("ssh_interactive_session");
  });
});

describe("Atlantic.Net agent script patterns", () => {
  it("should have at least 3 implemented agent scripts", () => {
    expect(atlanticnetEntries.length).toBeGreaterThanOrEqual(3);
  });

  for (const { key, agent, path } of atlanticnetEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source atlanticnet/lib/common.sh with fallback", () => {
        expect(content).toContain("atlanticnet/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should call ensure_atlanticnet_credentials", () => {
        expect(codeLines.some((l) => l.includes("ensure_atlanticnet_credentials"))).toBe(true);
      });

      it("should call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(true);
      });

      it("should call create_server with server name", () => {
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call verify_server_connectivity with ATLANTICNET_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("verify_server_connectivity"))).toBe(true);
        expect(codeLines.some((l) => l.includes("ATLANTICNET_SERVER_IP"))).toBe(true);
      });

      it("should reference OPENROUTER_API_KEY", () => {
        expect(codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))).toBe(true);
      });

      it("should NOT use inject_env_vars_local (Atlantic.Net is SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_local"))).toBe(false);
      });

      it("should inject env vars via inject_env_vars_ssh or manual export", () => {
        // Some scripts use inject_env_vars_ssh, others use manual run_server + export
        const usesHelper = codeLines.some((l) => l.includes("inject_env_vars_ssh"));
        const usesManualExport = codeLines.some(
          (l) => l.includes("export OPENROUTER_API_KEY") || l.includes("export OPENAI_API_KEY")
        );
        expect(usesHelper || usesManualExport).toBe(true);
      });

      it("should call interactive_session with ATLANTICNET_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
      });

      it("should pass IP to run_server calls", () => {
        // Atlantic.Net is SSH-based: run_server needs IP as first arg
        const runServerLines = codeLines.filter((l) => l.includes("run_server"));
        for (const line of runServerLines) {
          expect(line).toContain("ATLANTICNET_SERVER_IP");
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
// CodeSandbox
// ══════════════════════════════════════════════════════════════════════════════

const codesandboxLibPath = join(REPO_ROOT, "codesandbox", "lib", "common.sh");
const codesandboxLib = existsSync(codesandboxLibPath)
  ? readScript(codesandboxLibPath)
  : "";
const codesandboxFunctions = extractFunctions(codesandboxLib);
const codesandboxEntries = getImplementedEntries("codesandbox");

describe("CodeSandbox lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(codesandboxLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(codesandboxLib).toContain("shared/common.sh");
    expect(codesandboxLib).toContain("raw.githubusercontent.com");
    expect(codesandboxLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(codesandboxLib).toContain("set -eo pipefail");
  });

  // Required sandbox-type cloud functions
  const requiredFunctions = [
    "create_server",
    "destroy_server",
    "run_server",
    "upload_file",
    "interactive_session",
    "get_server_name",
    "wait_for_cloud_init",
  ];

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(codesandboxFunctions).toContain(fn);
    });
  }

  // CodeSandbox-specific functions
  const providerSpecificFunctions = [
    "ensure_codesandbox_cli",
    "ensure_codesandbox_token",
    "test_codesandbox_token",
    "validate_sandbox_id",
    "list_servers",
    "_invoke_codesandbox_create",
  ];

  for (const fn of providerSpecificFunctions) {
    it(`should define provider-specific ${fn}()`, () => {
      expect(codesandboxFunctions).toContain(fn);
    });
  }
});

describe("CodeSandbox SDK-based exec pattern", () => {
  it("should use Node.js SDK (@codesandbox/sdk) for all operations", () => {
    expect(codesandboxLib).toContain("@codesandbox/sdk");
  });

  it("should use CodeSandbox constructor for SDK initialization", () => {
    expect(codesandboxLib).toContain("new CodeSandbox(");
  });

  it("should pass sandbox ID via environment variable (not interpolation)", () => {
    // SECURITY: SDK calls should pass data via env vars
    expect(codesandboxLib).toContain("_CSB_SB_ID");
    expect(codesandboxLib).toContain("process.env._CSB_SB_ID");
  });

  it("should pass API key via environment variable", () => {
    expect(codesandboxLib).toContain("CSB_API_KEY");
    expect(codesandboxLib).toContain("process.env.CSB_API_KEY");
  });

  it("should pass name via environment variable in create", () => {
    expect(codesandboxLib).toContain("_CSB_NAME");
    expect(codesandboxLib).toContain("process.env._CSB_NAME");
  });

  it("should pass command via environment variable in run_server", () => {
    expect(codesandboxLib).toContain("_CSB_CMD");
    expect(codesandboxLib).toContain("process.env._CSB_CMD");
  });
});

describe("CodeSandbox sandbox ID validation", () => {
  it("should define validate_sandbox_id function", () => {
    expect(codesandboxFunctions).toContain("validate_sandbox_id");
  });

  it("should validate sandbox ID format with regex", () => {
    expect(codesandboxLib).toContain("[a-zA-Z0-9_-]");
  });

  it("should call validate_sandbox_id before run_server", () => {
    // The run_server function should validate the ID (directly or via called helper)
    const lines = codesandboxLib.split("\n");
    let inRunServer = false;
    let foundValidation = false;
    let foundNodeExec = false;
    for (const line of lines) {
      if (line.match(/^run_server\(\)/)) inRunServer = true;
      if (inRunServer && line.includes("validate_sandbox_id")) foundValidation = true;
      // Node -e is used in _csb_run_cmd which run_server delegates to
      if (inRunServer && (line.includes("node -e") || line.includes("_csb_run_cmd"))) foundNodeExec = true;
      if (inRunServer && line.match(/^}/)) break;
    }
    expect(foundValidation).toBe(true);
    expect(foundNodeExec).toBe(true);
  });

  it("should call validate_sandbox_id before interactive_session", () => {
    const lines = codesandboxLib.split("\n");
    let inFunc = false;
    let foundValidation = false;
    for (const line of lines) {
      if (line.match(/^interactive_session\(\)/)) inFunc = true;
      // Validation can be direct or via run_server delegation
      if (inFunc && (line.includes("validate_sandbox_id") || line.includes("run_server"))) foundValidation = true;
      if (inFunc && line.match(/^}/)) break;
    }
    expect(foundValidation).toBe(true);
  });

  it("should call validate_sandbox_id before destroy_server", () => {
    const lines = codesandboxLib.split("\n");
    let inFunc = false;
    let foundValidation = false;
    for (const line of lines) {
      if (line.match(/^destroy_server\(\)/)) inFunc = true;
      if (inFunc && line.includes("validate_sandbox_id")) foundValidation = true;
      if (inFunc && line.match(/^}/)) break;
    }
    expect(foundValidation).toBe(true);
  });
});

describe("CodeSandbox credential handling", () => {
  it("should use ensure_api_token_with_provider for token management", () => {
    expect(codesandboxLib).toContain("ensure_api_token_with_provider");
  });

  it("should use CSB_API_KEY as the token env var", () => {
    expect(codesandboxLib).toContain('"CSB_API_KEY"');
  });

  it("should save credentials to ~/.config/spawn/codesandbox.json", () => {
    expect(codesandboxLib).toContain("codesandbox.json");
  });

  it("should point users to the correct API key page", () => {
    expect(codesandboxLib).toContain("codesandbox.io/t/api");
  });

  it("should test credentials via SDK sandboxes list", () => {
    expect(codesandboxLib).toContain("sandboxes list");
  });
});

describe("CodeSandbox does NOT use SSH patterns", () => {
  it("should NOT define ensure_ssh_key", () => {
    expect(codesandboxFunctions).not.toContain("ensure_ssh_key");
  });

  it("should NOT define verify_server_connectivity", () => {
    expect(codesandboxFunctions).not.toContain("verify_server_connectivity");
  });

  it("should NOT reference ssh_run_server or ssh_upload_file", () => {
    const codeLines = getCodeLines(codesandboxLib);
    expect(codeLines.some((l) => l.includes("ssh_run_server"))).toBe(false);
    expect(codeLines.some((l) => l.includes("ssh_upload_file"))).toBe(false);
  });

  it("should NOT reference generic_ssh_wait", () => {
    const codeLines = getCodeLines(codesandboxLib);
    expect(codeLines.some((l) => l.includes("generic_ssh_wait"))).toBe(false);
  });
});

describe("CodeSandbox upload_file security", () => {
  it("should validate remote path with strict allowlist regex", () => {
    expect(codesandboxLib).toContain("remote_path");
    // The validation line checks for unsafe characters
    const uploadLines = codesandboxLib.split("\n").filter((l) =>
      l.includes("remote_path") && l.includes("Invalid")
    );
    // There should be at least one validation check that rejects unsafe chars
    expect(uploadLines.length).toBeGreaterThan(0);
    // Uses strict allowlist regex instead of blocklist
    expect(codesandboxLib).toMatch(/\[a-zA-Z0-9/);
  });

  it("should use base64 for safe file content transfer", () => {
    expect(codesandboxLib).toContain("base64");
  });

  it("should use SDK filesystem API via env vars", () => {
    expect(codesandboxLib).toContain("_CSB_REMOTE_PATH");
    expect(codesandboxLib).toContain("process.env._CSB_REMOTE_PATH");
  });
});

describe("CodeSandbox agent script patterns", () => {
  it("should have at least 3 implemented agent scripts", () => {
    expect(codesandboxEntries.length).toBeGreaterThanOrEqual(3);
  });

  for (const { key, agent, path } of codesandboxEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source codesandbox/lib/common.sh with fallback", () => {
        expect(content).toContain("codesandbox/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should call ensure_codesandbox_cli", () => {
        expect(codeLines.some((l) => l.includes("ensure_codesandbox_cli"))).toBe(true);
      });

      it("should call ensure_codesandbox_token", () => {
        expect(codeLines.some((l) => l.includes("ensure_codesandbox_token"))).toBe(true);
      });

      it("should call create_server with server name", () => {
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call wait_for_cloud_init", () => {
        expect(codeLines.some((l) => l.includes("wait_for_cloud_init"))).toBe(true);
      });

      it("should reference OPENROUTER_API_KEY", () => {
        expect(codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))).toBe(true);
      });

      it("should NOT use inject_env_vars_ssh (CodeSandbox is SDK-based)", () => {
        // CodeSandbox is SDK-based, not SSH-based — must never use SSH env injection
        expect(codeLines.some((l) => l.includes("inject_env_vars_ssh"))).toBe(false);
      });

      it("should inject env vars via inject_env_vars_local or manual echo", () => {
        // Some scripts use inject_env_vars_local, others do manual echo injection
        const usesHelper = codeLines.some((l) => l.includes("inject_env_vars_local"));
        const usesManualEcho = codeLines.some(
          (l) => l.includes(">> ~/.bashrc") || l.includes(">> ~/.zshrc")
        );
        expect(usesHelper || usesManualEcho).toBe(true);
      });

      it("should call interactive_session without IP (SDK-based)", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
        // Unlike SSH clouds, CodeSandbox interactive_session takes only a command
        // (no IP address as first arg)
        const interactiveLines = codeLines.filter((l) =>
          l.match(/^\s*interactive_session\s/)
        );
        for (const line of interactiveLines) {
          expect(line).not.toContain("ATLANTICNET_SERVER_IP");
          expect(line).not.toContain("SERVER_IP");
        }
      });

      it("should call run_server without IP (SDK-based)", () => {
        // CodeSandbox run_server takes only a command (no IP needed)
        const runServerLines = codeLines.filter((l) => l.match(/^\s*run_server\s/));
        for (const line of runServerLines) {
          expect(line).not.toContain("ATLANTICNET_SERVER_IP");
        }
      });

      it("should NOT call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(false);
      });

      it("should NOT call verify_server_connectivity", () => {
        expect(codeLines.some((l) => l.includes("verify_server_connectivity"))).toBe(false);
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
// Cross-provider contrast tests
// ══════════════════════════════════════════════════════════════════════════════

describe("Atlantic.Net vs CodeSandbox: architectural contrast", () => {
  it("Atlantic.Net should be SSH-based, CodeSandbox should not be", () => {
    const atlanticDef = manifest.clouds["atlanticnet"];
    const codesandboxDef = manifest.clouds["codesandbox"];

    if (atlanticDef) {
      expect(atlanticDef.exec_method).toContain("ssh");
    }
    if (codesandboxDef) {
      expect(codesandboxDef.exec_method).not.toContain("ssh");
    }
  });

  it("Atlantic.Net should define SSH delegation functions", () => {
    expect(atlanticnetLib).toContain("ssh_run_server");
    expect(atlanticnetLib).toContain("ssh_upload_file");
  });

  it("CodeSandbox should use Node.js SDK instead of SSH", () => {
    expect(codesandboxLib).toContain("node -e");
    expect(codesandboxLib).toContain("@codesandbox/sdk");
    expect(codesandboxLib).not.toContain("ssh_run_server");
  });

  it("Atlantic.Net should use dual credentials (key + private key)", () => {
    expect(atlanticnetLib).toContain("ATLANTICNET_API_KEY");
    expect(atlanticnetLib).toContain("ATLANTICNET_API_PRIVATE_KEY");
  });

  it("CodeSandbox should use single token", () => {
    expect(codesandboxLib).toContain("CSB_API_KEY");
    // Should use the shared ensure_api_token_with_provider pattern
    expect(codesandboxLib).toContain("ensure_api_token_with_provider");
  });

  it("Atlantic.Net agent scripts should pass IP to run_server/interactive_session", () => {
    // SSH-based: commands need the IP address
    if (atlanticnetEntries.length > 0) {
      const content = readScript(atlanticnetEntries[0].path);
      const codeLines = getCodeLines(content);
      const runLines = codeLines.filter((l) => l.match(/^\s*run_server\s/));
      expect(runLines.length).toBeGreaterThan(0);
      expect(runLines.some((l) => l.includes("ATLANTICNET_SERVER_IP"))).toBe(true);
    }
  });

  it("CodeSandbox agent scripts should NOT pass IP to run_server/interactive_session", () => {
    // SDK-based: commands don't need an IP (sandbox ID is used internally)
    if (codesandboxEntries.length > 0) {
      const content = readScript(codesandboxEntries[0].path);
      const codeLines = getCodeLines(content);
      const runLines = codeLines.filter((l) => l.match(/^\s*run_server\s/));
      for (const line of runLines) {
        // Should be like: run_server "some command" (no IP)
        expect(line).not.toMatch(/run_server\s+"\$\{?\w+_SERVER_IP/);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Manifest consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("Manifest consistency for new providers", () => {
  it("atlanticnet should be in manifest.clouds", () => {
    expect(manifest.clouds["atlanticnet"]).toBeDefined();
  });

  it("codesandbox should be in manifest.clouds", () => {
    expect(manifest.clouds["codesandbox"]).toBeDefined();
  });

  it("atlanticnet should have type 'api'", () => {
    expect(manifest.clouds["atlanticnet"]?.type).toBe("api");
  });

  it("atlanticnet matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("atlanticnet/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("codesandbox matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("codesandbox/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("every atlanticnet/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix)
      .filter(([key, status]) => key.startsWith("atlanticnet/") && status === "implemented");
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });

  it("every codesandbox/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix)
      .filter(([key, status]) => key.startsWith("codesandbox/") && status === "implemented");
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });
});
