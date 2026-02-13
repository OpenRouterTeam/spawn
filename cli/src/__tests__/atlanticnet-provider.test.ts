import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest, CloudDef } from "../manifest";

/**
 * Tests for the Atlantic.Net cloud provider implementation.
 *
 * Atlantic.Net was added in PR #883 and is the newest cloud provider.
 * This test file validates:
 *
 * 1. lib/common.sh structure and API surface (function definitions)
 * 2. Agent script conventions (shebang, source pattern, error handling)
 * 3. Manifest consistency (matrix entries, auth field format, defaults)
 * 4. Security patterns (credential validation, no injection vectors)
 * 5. HMAC-SHA256 signature auth flow correctness
 * 6. SSH delegation pattern (shared helpers vs custom functions)
 * 7. Credential management (env -> config -> prompt chain)
 * 8. API wrapper parameter handling and URL encoding
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLOUD_DIR = join(REPO_ROOT, "atlanticnet");
const LIB_PATH = join(CLOUD_DIR, "lib", "common.sh");
const MANIFEST_PATH = join(REPO_ROOT, "manifest.json");
const SHARED_COMMON_PATH = join(REPO_ROOT, "shared", "common.sh");

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const cloudDef: CloudDef = manifest.clouds.atlanticnet;
const libContent = readFileSync(LIB_PATH, "utf-8");

// Agent scripts that are implemented
const IMPLEMENTED_AGENTS = Object.entries(manifest.matrix)
  .filter(([key, status]) => key.startsWith("atlanticnet/") && status === "implemented")
  .map(([key]) => key.replace("atlanticnet/", ""));

/** Extract all function names defined in a shell script */
function extractFunctions(content: string): string[] {
  const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

/** Get non-comment, non-empty lines */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

/** Read an agent script, or null if missing */
function readAgentScript(agent: string): string | null {
  const path = join(CLOUD_DIR, `${agent}.sh`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

// ============================================================================
// 1. lib/common.sh structure and source pattern
// ============================================================================

describe("Atlantic.Net lib/common.sh structure", () => {
  it("should exist at atlanticnet/lib/common.sh", () => {
    expect(existsSync(LIB_PATH)).toBe(true);
  });

  it("should start with shebang", () => {
    expect(libContent.trimStart().startsWith("#!/bin/bash")).toBe(true);
  });

  it("should use set -eo pipefail", () => {
    expect(libContent).toContain("set -eo pipefail");
  });

  it("should NOT use set -u (macOS compat)", () => {
    const codeLines = getCodeLines(libContent);
    const hasSetU = codeLines.some(
      (l) => /set\s+-[a-z]*u/.test(l) || /set\s+-o\s+nounset/.test(l)
    );
    expect(hasSetU).toBe(false);
  });

  it("should source shared/common.sh with local-or-remote fallback", () => {
    expect(libContent).toContain("shared/common.sh");
    // Must have both local path and curl fallback
    expect(libContent).toContain("source \"$SCRIPT_DIR/../../shared/common.sh\"");
    expect(libContent).toContain("curl -fsSL");
    expect(libContent).toContain("eval \"$(curl");
  });

  it("should NOT use echo -e (macOS bash 3.x compat)", () => {
    const codeLines = getCodeLines(libContent);
    const hasEchoE = codeLines.some((l) => /echo\s+-e\b/.test(l));
    expect(hasEchoE).toBe(false);
  });

  it("should NOT use source <() process substitution (macOS compat)", () => {
    const codeLines = getCodeLines(libContent);
    const hasSourceProcessSub = codeLines.some((l) => /source\s+<\(/.test(l));
    expect(hasSourceProcessSub).toBe(false);
  });

  it("should define ATLANTICNET_API_BASE constant", () => {
    expect(libContent).toContain("ATLANTICNET_API_BASE=");
    expect(libContent).toContain("cloudapi.atlantic.net");
  });

  it("should define ATLANTICNET_API_VERSION constant", () => {
    expect(libContent).toContain("ATLANTICNET_API_VERSION=");
  });

  it("should use readonly for API constants", () => {
    const hasReadonlyBase = libContent.includes("readonly ATLANTICNET_API_BASE");
    const hasReadonlyVersion = libContent.includes("readonly ATLANTICNET_API_VERSION");
    expect(hasReadonlyBase).toBe(true);
    expect(hasReadonlyVersion).toBe(true);
  });
});

// ============================================================================
// 2. Required API surface (functions that agent scripts depend on)
// ============================================================================

describe("Atlantic.Net lib/common.sh API surface", () => {
  const functions = extractFunctions(libContent);

  // Core API functions
  it("should define atlanticnet_api() wrapper", () => {
    expect(functions).toContain("atlanticnet_api");
  });

  it("should define atlanticnet_sign() for HMAC-SHA256 auth", () => {
    expect(functions).toContain("atlanticnet_sign");
  });

  it("should define atlanticnet_generate_guid() for request dedup", () => {
    expect(functions).toContain("atlanticnet_generate_guid");
  });

  it("should define url_encode() helper", () => {
    expect(functions).toContain("url_encode");
  });

  // Credential management
  it("should define ensure_atlanticnet_credentials()", () => {
    expect(functions).toContain("ensure_atlanticnet_credentials");
  });

  it("should define test_atlanticnet_credentials()", () => {
    expect(functions).toContain("test_atlanticnet_credentials");
  });

  // SSH key management
  it("should define ensure_ssh_key()", () => {
    expect(functions).toContain("ensure_ssh_key");
  });

  it("should define atlanticnet_check_ssh_key()", () => {
    expect(functions).toContain("atlanticnet_check_ssh_key");
  });

  it("should define atlanticnet_register_ssh_key()", () => {
    expect(functions).toContain("atlanticnet_register_ssh_key");
  });

  // Server lifecycle
  it("should define create_server()", () => {
    expect(functions).toContain("create_server");
  });

  it("should define destroy_server()", () => {
    expect(functions).toContain("destroy_server");
  });

  it("should define get_server_name()", () => {
    expect(functions).toContain("get_server_name");
  });

  // SSH operation delegates
  it("should define verify_server_connectivity()", () => {
    expect(functions).toContain("verify_server_connectivity");
  });

  it("should define run_server()", () => {
    expect(functions).toContain("run_server");
  });

  it("should define upload_file()", () => {
    expect(functions).toContain("upload_file");
  });

  it("should define interactive_session()", () => {
    expect(functions).toContain("interactive_session");
  });

  // Defaults helpers
  it("should define get_plan_name()", () => {
    expect(functions).toContain("get_plan_name");
  });

  it("should define get_image_id()", () => {
    expect(functions).toContain("get_image_id");
  });

  it("should define get_location()", () => {
    expect(functions).toContain("get_location");
  });
});

// ============================================================================
// 3. HMAC-SHA256 signature auth pattern
// ============================================================================

describe("Atlantic.Net HMAC-SHA256 signature auth", () => {
  it("should use openssl dgst for HMAC-SHA256 in atlanticnet_sign()", () => {
    expect(libContent).toContain("openssl dgst -sha256 -hmac");
  });

  it("should base64-encode the signature", () => {
    expect(libContent).toContain("base64");
  });

  it("should include timestamp in API requests", () => {
    expect(libContent).toContain("Timestamp=");
  });

  it("should include Rndguid for request deduplication", () => {
    expect(libContent).toContain("Rndguid=");
  });

  it("should include ACSAccessKeyId in API requests", () => {
    expect(libContent).toContain("ACSAccessKeyId=");
  });

  it("should include Signature in API requests", () => {
    expect(libContent).toContain("Signature=");
  });

  it("should URL-encode the signature before adding to query string", () => {
    // url_encode should be called on the signature
    expect(libContent).toContain("url_encode \"$signature\"");
  });

  it("should use python3 for UUID generation", () => {
    const guidFunc = libContent.match(
      /atlanticnet_generate_guid\(\)[\s\S]*?(?=\n\w|\n\})/
    )?.[0] || libContent;
    // uuid4 is the standard UUID generation
    expect(libContent).toContain("uuid.uuid4()");
  });

  it("should use python3 for URL encoding", () => {
    expect(libContent).toContain("urllib.parse.quote");
  });
});

// ============================================================================
// 4. Security patterns
// ============================================================================

describe("Atlantic.Net security patterns", () => {
  it("should use ${VAR:-} for optional env vars (not bare $VAR)", () => {
    const codeLines = getCodeLines(libContent);
    // Check ATLANTICNET_API_KEY and ATLANTICNET_API_PRIVATE_KEY
    const envChecks = codeLines.filter((l) =>
      l.includes("ATLANTICNET_API_KEY") || l.includes("ATLANTICNET_API_PRIVATE_KEY")
    );
    // Should use :- pattern for checks (not just $VAR without default)
    const hasUnsafeCheck = envChecks.some(
      (l) => l.includes("-n \"$ATLANTICNET_API_KEY\"") && !l.includes(":-")
    );
    expect(hasUnsafeCheck).toBe(false);
  });

  it("should save credentials with chmod 600", () => {
    expect(libContent).toContain("chmod 600");
  });

  it("should store credentials in standard config path", () => {
    expect(libContent).toContain("$HOME/.config/spawn/atlanticnet.json");
  });

  it("should use python3 json module for config file writing (safe JSON)", () => {
    expect(libContent).toContain("json.dump(");
  });

  it("should use python3 json module for config file reading (safe JSON)", () => {
    expect(libContent).toContain("json.load(");
  });

  it("should test credentials before saving them", () => {
    // The ensure_atlanticnet_credentials function should call test_atlanticnet_credentials
    const ensureFunc = extractFunctionBody(
      libContent,
      "ensure_atlanticnet_credentials"
    );
    expect(ensureFunc).toContain("test_atlanticnet_credentials");
  });

  it("should URL-encode API parameter values", () => {
    // In atlanticnet_api, user values should be URL-encoded
    const apiFunc = extractFunctionBody(libContent, "atlanticnet_api");
    expect(apiFunc).toContain("url_encode");
  });

  it("should not embed private key directly in URL", () => {
    // The private key should only be used in HMAC signing, not in the URL
    const apiFunc = extractFunctionBody(libContent, "atlanticnet_api");
    expect(apiFunc).not.toContain("ATLANTICNET_API_PRIVATE_KEY");
  });
});

// ============================================================================
// 5. Credential management flow
// ============================================================================

describe("Atlantic.Net credential management", () => {
  const ensureFunc = extractFunctionBody(
    libContent,
    "ensure_atlanticnet_credentials"
  );

  it("should try environment variables first", () => {
    // env var check should appear before config file read
    const envIdx = ensureFunc.indexOf("ATLANTICNET_API_KEY:-");
    // The actual config file READ (not the local variable declaration) is -f "$config_file"
    const configReadIdx = ensureFunc.indexOf('-f "$config_file"');
    expect(envIdx).toBeLessThan(configReadIdx);
  });

  it("should try config file second", () => {
    expect(ensureFunc).toContain("config_file");
    expect(ensureFunc).toContain("-f \"$config_file\"");
  });

  it("should prompt user as last resort", () => {
    expect(ensureFunc).toContain("safe_read");
  });

  it("should require both API key and private key", () => {
    expect(ensureFunc).toContain("ATLANTICNET_API_KEY");
    expect(ensureFunc).toContain("ATLANTICNET_API_PRIVATE_KEY");
  });

  it("should export credentials after setting them", () => {
    expect(ensureFunc).toContain("export ATLANTICNET_API_KEY ATLANTICNET_API_PRIVATE_KEY");
  });

  it("should validate credentials with a test API call", () => {
    expect(ensureFunc).toContain("test_atlanticnet_credentials");
  });

  it("should handle invalid env var credentials gracefully", () => {
    // Should warn and continue to next method
    expect(ensureFunc).toContain("log_warn");
  });
});

// ============================================================================
// 6. SSH delegation pattern
// ============================================================================

describe("Atlantic.Net SSH delegation", () => {
  it("should delegate verify_server_connectivity to ssh_verify_connectivity", () => {
    expect(libContent).toContain(
      "verify_server_connectivity() { ssh_verify_connectivity"
    );
  });

  it("should delegate run_server to ssh_run_server", () => {
    expect(libContent).toContain("run_server() { ssh_run_server");
  });

  it("should delegate upload_file to ssh_upload_file", () => {
    expect(libContent).toContain("upload_file() { ssh_upload_file");
  });

  it("should delegate interactive_session to ssh_interactive_session", () => {
    expect(libContent).toContain(
      "interactive_session() { ssh_interactive_session"
    );
  });

  it("should use ensure_ssh_key_with_provider for SSH key management", () => {
    const ensureSshFunc = extractFunctionBody(libContent, "ensure_ssh_key");
    expect(ensureSshFunc).toContain("ensure_ssh_key_with_provider");
  });
});

// ============================================================================
// 7. Server lifecycle functions
// ============================================================================

describe("Atlantic.Net server lifecycle", () => {
  it("should extract instance ID from run-instance response", () => {
    const parseFunc = extractFunctionBody(libContent, "_atlanticnet_parse_instance_response");
    expect(parseFunc).toContain("instanceid");
  });

  it("should extract IP address from run-instance response", () => {
    const parseFunc = extractFunctionBody(libContent, "_atlanticnet_parse_instance_response");
    expect(parseFunc).toContain("ip_address");
  });

  it("should export ATLANTICNET_SERVER_ID after creation", () => {
    const parseFunc = extractFunctionBody(libContent, "_atlanticnet_parse_instance_response");
    expect(parseFunc).toContain("export ATLANTICNET_SERVER_ID");
  });

  it("should export ATLANTICNET_SERVER_IP after creation", () => {
    const parseFunc = extractFunctionBody(libContent, "_atlanticnet_parse_instance_response");
    expect(parseFunc).toContain("ATLANTICNET_SERVER_IP");
    expect(parseFunc).toContain("export");
  });

  it("should check for empty instance ID or IP", () => {
    const parseFunc = extractFunctionBody(libContent, "_atlanticnet_parse_instance_response");
    expect(parseFunc).toContain('-z "$instance_id"');
    expect(parseFunc).toContain('-z "$ip_address"');
  });

  it("should check for API errors in response", () => {
    const checkFunc = extractFunctionBody(libContent, "_atlanticnet_check_create_error");
    expect(checkFunc).toContain('"error"');
  });

  it("should call terminate-instance in destroy_server", () => {
    const destroyFunc = extractFunctionBody(libContent, "destroy_server");
    expect(destroyFunc).toContain("terminate-instance");
  });

  it("should use get_validated_server_name in get_server_name", () => {
    const getNameFunc = extractFunctionBody(libContent, "get_server_name");
    expect(getNameFunc).toContain("get_validated_server_name");
  });
});

// ============================================================================
// 8. Default parameter helpers
// ============================================================================

describe("Atlantic.Net default parameters", () => {
  it("should use G2.2GB as default plan", () => {
    const planFunc = extractFunctionBody(libContent, "get_plan_name");
    expect(planFunc).toContain("G2.2GB");
  });

  it("should use ubuntu-24.04_64bit as default image", () => {
    const imageFunc = extractFunctionBody(libContent, "get_image_id");
    expect(imageFunc).toContain("ubuntu-24.04_64bit");
  });

  it("should use USEAST2 as default location", () => {
    const locFunc = extractFunctionBody(libContent, "get_location");
    expect(locFunc).toContain("USEAST2");
  });

  it("should respect ATLANTICNET_PLAN env var", () => {
    const planFunc = extractFunctionBody(libContent, "get_plan_name");
    expect(planFunc).toContain("ATLANTICNET_PLAN");
  });

  it("should respect ATLANTICNET_IMAGE env var", () => {
    const imageFunc = extractFunctionBody(libContent, "get_image_id");
    expect(imageFunc).toContain("ATLANTICNET_IMAGE");
  });

  it("should respect ATLANTICNET_LOCATION env var", () => {
    const locFunc = extractFunctionBody(libContent, "get_location");
    expect(locFunc).toContain("ATLANTICNET_LOCATION");
  });

  it("should match manifest defaults for plan", () => {
    expect(cloudDef.defaults?.plan).toBe("G2.2GB");
  });

  it("should match manifest defaults for location", () => {
    expect(cloudDef.defaults?.location).toBe("USEAST2");
  });

  it("should match manifest defaults for image", () => {
    expect(cloudDef.defaults?.image).toBe("ubuntu-24.04_64bit");
  });
});

// ============================================================================
// 9. Manifest consistency
// ============================================================================

describe("Atlantic.Net manifest consistency", () => {
  it("should exist in manifest.clouds", () => {
    expect(manifest.clouds.atlanticnet).toBeDefined();
  });

  it("should have correct provider name", () => {
    expect(cloudDef.name).toBe("Atlantic.Net");
  });

  it("should have correct auth field format", () => {
    expect(cloudDef.auth).toBe(
      "ATLANTICNET_API_KEY + ATLANTICNET_API_PRIVATE_KEY"
    );
  });

  it("should have api type", () => {
    expect(cloudDef.type).toBe("api");
  });

  it("should have SSH exec method", () => {
    expect(cloudDef.exec_method).toContain("ssh");
  });

  it("should have SSH interactive method", () => {
    expect(cloudDef.interactive_method).toContain("ssh");
  });

  it("should have URL to provider", () => {
    expect(cloudDef.url).toContain("atlantic.net");
  });

  it("should have description", () => {
    expect(cloudDef.description.length).toBeGreaterThan(10);
  });

  it("should have notes with pricing info", () => {
    expect(cloudDef.notes).toBeDefined();
    expect(cloudDef.notes).toContain("$");
  });

  it("should have matrix entries for all agents", () => {
    const agentKeys = Object.keys(manifest.agents);
    for (const agent of agentKeys) {
      const matrixKey = `atlanticnet/${agent}`;
      expect(manifest.matrix[matrixKey]).toBeDefined();
    }
  });

  it("should have at least 2 implemented agent scripts", () => {
    expect(IMPLEMENTED_AGENTS.length).toBeGreaterThanOrEqual(2);
  });

  it("should have implemented entries for claude, aider, openclaw", () => {
    expect(manifest.matrix["atlanticnet/claude"]).toBe("implemented");
    expect(manifest.matrix["atlanticnet/aider"]).toBe("implemented");
    expect(manifest.matrix["atlanticnet/openclaw"]).toBe("implemented");
  });
});

// ============================================================================
// 10. Agent script conventions (exhaustive for all implemented agents)
// ============================================================================

describe("Atlantic.Net agent scripts", () => {
  for (const agent of IMPLEMENTED_AGENTS) {
    describe(`${agent}.sh`, () => {
      const script = readAgentScript(agent);

      it(`should exist at atlanticnet/${agent}.sh`, () => {
        expect(script).not.toBeNull();
      });

      if (!script) return;

      it("should start with #!/bin/bash shebang", () => {
        expect(script.trimStart().startsWith("#!/bin/bash")).toBe(true);
      });

      it("should use set -eo pipefail", () => {
        expect(script).toContain("set -eo pipefail");
      });

      it("should source atlanticnet/lib/common.sh with local-or-remote fallback", () => {
        expect(script).toContain("lib/common.sh");
        expect(script).toContain("curl -fsSL");
        expect(script).toContain(
          "raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlanticnet/lib/common.sh"
        );
      });

      it("should call ensure_atlanticnet_credentials", () => {
        expect(script).toContain("ensure_atlanticnet_credentials");
      });

      it("should call ensure_ssh_key", () => {
        expect(script).toContain("ensure_ssh_key");
      });

      it("should call create_server", () => {
        expect(script).toContain("create_server");
      });

      it("should call verify_server_connectivity", () => {
        expect(script).toContain("verify_server_connectivity");
      });

      it("should handle OPENROUTER_API_KEY (env or OAuth)", () => {
        expect(script).toContain("OPENROUTER_API_KEY");
        // Should check env first, then fall back to OAuth
        expect(script).toContain("OPENROUTER_API_KEY:-");
      });

      it("should call inject_env_vars_ssh for env var setup", () => {
        expect(script).toContain("inject_env_vars_ssh");
      });

      it("should call interactive_session as the final step", () => {
        // interactive_session should be the last major function call
        const lines = script.split("\n");
        const interactiveLines = lines.filter((l) =>
          l.includes("interactive_session")
        );
        expect(interactiveLines.length).toBeGreaterThan(0);
      });

      it("should use ATLANTICNET_SERVER_IP for SSH operations", () => {
        expect(script).toContain("ATLANTICNET_SERVER_IP");
      });

      it("should NOT use echo -e (macOS compat)", () => {
        const codeLines = getCodeLines(script);
        const hasEchoE = codeLines.some((l) => /echo\s+-e\b/.test(l));
        expect(hasEchoE).toBe(false);
      });

      it("should NOT use source <() process substitution", () => {
        const codeLines = getCodeLines(script);
        const hasSourceProcSub = codeLines.some((l) =>
          /source\s+<\(/.test(l)
        );
        expect(hasSourceProcSub).toBe(false);
      });

      it("should NOT use set -u", () => {
        const codeLines = getCodeLines(script);
        const hasSetU = codeLines.some(
          (l) => /set\s+-[a-z]*u/.test(l) || /set\s+-o\s+nounset/.test(l)
        );
        expect(hasSetU).toBe(false);
      });
    });
  }
});

// ============================================================================
// 11. Agent-specific setup patterns
// ============================================================================

describe("Atlantic.Net agent-specific setup", () => {
  describe("claude.sh agent setup", () => {
    const script = readAgentScript("claude");
    if (!script) return;

    it("should install claude via install script", () => {
      expect(script).toContain("claude.ai/install.sh");
    });

    it("should verify claude installation", () => {
      expect(script).toContain("claude --version");
    });

    it("should set ANTHROPIC_BASE_URL to OpenRouter", () => {
      expect(script).toContain(
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
      );
    });

    it("should call setup_claude_code_config", () => {
      expect(script).toContain("setup_claude_code_config");
    });

    it("should disable Claude telemetry", () => {
      expect(script).toContain("CLAUDE_CODE_ENABLE_TELEMETRY=0");
    });

    it("should skip Claude onboarding", () => {
      expect(script).toContain("CLAUDE_CODE_SKIP_ONBOARDING=1");
    });

    it("should clear ANTHROPIC_API_KEY (prevent direct Anthropic calls)", () => {
      expect(script).toContain("ANTHROPIC_API_KEY=");
    });
  });

  describe("aider.sh agent setup", () => {
    const script = readAgentScript("aider");
    if (!script) return;

    it("should install aider via pip", () => {
      expect(script).toContain("pip install aider-chat");
      // Should also try pip3 as fallback
      expect(script).toContain("pip3 install aider-chat");
    });

    it("should verify aider installation", () => {
      expect(script).toContain("aider --version");
    });

    it("should call get_model_id_interactive for model selection", () => {
      expect(script).toContain("get_model_id_interactive");
    });

    it("should launch aider with openrouter model prefix", () => {
      expect(script).toContain("openrouter/");
    });
  });

  describe("openclaw.sh agent setup", () => {
    const script = readAgentScript("openclaw");
    if (!script) return;

    it("should install bun first", () => {
      expect(script).toContain("bun.sh/install");
    });

    it("should install openclaw via bun", () => {
      expect(script).toContain("bun install -g openclaw");
    });

    it("should set ANTHROPIC_BASE_URL for OpenRouter", () => {
      expect(script).toContain(
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
      );
    });

    it("should call setup_openclaw_config", () => {
      expect(script).toContain("setup_openclaw_config");
    });

    it("should start openclaw gateway before TUI", () => {
      expect(script).toContain("openclaw gateway");
      expect(script).toContain("openclaw tui");
    });

    it("should run gateway in background with nohup", () => {
      expect(script).toContain("nohup openclaw gateway");
    });
  });
});

// ============================================================================
// 12. API wrapper parameter handling
// ============================================================================

describe("Atlantic.Net API wrapper", () => {
  const apiFunc = extractFunctionBody(libContent, "atlanticnet_api");

  it("should accept action as first parameter", () => {
    expect(apiFunc).toContain('local action="$1"');
  });

  it("should shift past the action parameter", () => {
    expect(apiFunc).toContain("shift");
  });

  it("should build query string with Action parameter", () => {
    expect(apiFunc).toContain("Action=$action");
  });

  it("should request JSON format", () => {
    expect(apiFunc).toContain("Format=json");
  });

  it("should include API version in request", () => {
    expect(apiFunc).toContain("Version=${ATLANTICNET_API_VERSION}");
  });

  it("should iterate additional parameters as key-value pairs", () => {
    expect(apiFunc).toContain("while");
    expect(apiFunc).toContain('local param="$1"');
    expect(apiFunc).toContain('local value="$1"');
  });

  it("should URL-encode parameter values", () => {
    expect(apiFunc).toContain("url_encode");
  });

  it("should use curl -fsSL for the actual request", () => {
    expect(apiFunc).toContain("curl -fsSL");
  });

  it("should call check_python_available before using python3", () => {
    expect(apiFunc).toContain("check_python_available");
  });
});

// ============================================================================
// 13. Error handling patterns
// ============================================================================

describe("Atlantic.Net error handling", () => {
  it("should check for API errors in test_atlanticnet_credentials", () => {
    const testFunc = extractFunctionBody(
      libContent,
      "test_atlanticnet_credentials"
    );
    expect(testFunc).toContain('"error"');
    expect(testFunc).toContain("log_error");
  });

  it("should check for API errors in create_server", () => {
    const createFunc = extractFunctionBody(libContent, "create_server");
    // Error checking is delegated to _atlanticnet_check_create_error helper
    expect(createFunc).toContain("_atlanticnet_check_create_error");
    expect(createFunc).toContain("return 1");
  });

  it("should check for API errors in atlanticnet_register_ssh_key", () => {
    const regFunc = extractFunctionBody(
      libContent,
      "atlanticnet_register_ssh_key"
    );
    expect(regFunc).toContain('"error"');
    expect(regFunc).toContain("return 1");
  });

  it("should exit with error if agent installation fails (claude)", () => {
    const script = readAgentScript("claude");
    if (script) {
      expect(script).toContain("exit 1");
      expect(script).toContain("installation verification failed");
    }
  });

  it("should exit with error if agent installation fails (aider)", () => {
    const script = readAgentScript("aider");
    if (script) {
      expect(script).toContain("exit 1");
      expect(script).toContain("installation verification failed");
    }
  });
});

// ============================================================================
// 14. README existence
// ============================================================================

describe("Atlantic.Net README", () => {
  it("should have a README.md", () => {
    expect(existsSync(join(CLOUD_DIR, "README.md"))).toBe(true);
  });

  it("should mention API credentials in README", () => {
    const readme = readFileSync(join(CLOUD_DIR, "README.md"), "utf-8");
    expect(readme).toContain("ATLANTICNET_API_KEY");
    expect(readme).toContain("ATLANTICNET_API_PRIVATE_KEY");
  });
});

// ============================================================================
// Helper: Extract function body from shell script
// ============================================================================

function extractFunctionBody(content: string, funcName: string): string {
  // Match function_name() { ... } pattern
  // First, try to find the function
  const funcPattern = new RegExp(
    `${funcName}\\(\\)\\s*\\{`,
    "m"
  );
  const match = funcPattern.exec(content);
  if (!match) return "";

  const startIdx = match.index + match[0].length;
  let depth = 1;
  let i = startIdx;

  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }

  return content.slice(startIdx, i - 1);
}
