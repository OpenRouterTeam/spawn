import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Pattern tests for the Alibaba Cloud (alibabacloud) provider.
 *
 * Alibaba Cloud is a CLI-based provider using:
 * - aliyun CLI (installed via official installer)
 * - Dual credential auth (ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET)
 * - SSH-based exec (root@IP)
 * - ECS instances with VPC/vSwitch/SecurityGroup management
 *
 * These tests validate:
 * 1. lib/common.sh defines the correct provider-specific API surface
 * 2. Agent scripts follow the correct provisioning flow
 * 3. Security conventions are enforced (env var validation, safe JSON parsing)
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

/** Collect implemented entries for alibabacloud */
function getImplementedEntries() {
  return Object.entries(manifest.matrix)
    .filter(
      ([key, status]) =>
        key.startsWith("alibabacloud/") && status === "implemented"
    )
    .map(([key]) => {
      const agent = key.split("/")[1];
      return { key, agent, path: join(REPO_ROOT, key + ".sh") };
    })
    .filter(({ path }) => existsSync(path));
}

const alibabaLibPath = join(REPO_ROOT, "alibabacloud", "lib", "common.sh");
const alibabaLib = existsSync(alibabaLibPath) ? readScript(alibabaLibPath) : "";
const alibabaFunctions = extractFunctions(alibabaLib);
const alibabaEntries = getImplementedEntries();

// ══════════════════════════════════════════════════════════════════════════════
// lib/common.sh API surface
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(alibabaLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(alibabaLib).toContain("shared/common.sh");
    expect(alibabaLib).toContain("raw.githubusercontent.com");
    expect(alibabaLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(alibabaLib).toContain("set -eo pipefail");
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
      expect(alibabaFunctions).toContain(fn);
    });
  }

  // Alibaba Cloud-specific functions
  const providerSpecificFunctions = [
    "ensure_aliyun_cli",
    "test_aliyun_credentials",
    "ensure_aliyun_credentials",
    "aliyun_check_ssh_key",
    "aliyun_register_ssh_key",
    "_wait_for_aliyun_instance",
    "_ensure_security_group",
  ];

  for (const fn of providerSpecificFunctions) {
    it(`should define provider-specific ${fn}()`, () => {
      expect(alibabaFunctions).toContain(fn);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CLI installation
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud CLI installation", () => {
  it("should install aliyun CLI from official source", () => {
    expect(alibabaLib).toContain("aliyuncli.alicdn.com/install.sh");
  });

  it("should check if aliyun CLI is already installed before installing", () => {
    expect(alibabaLib).toContain("command -v aliyun");
  });

  it("should verify aliyun CLI is accessible after installation", () => {
    // Should check command -v after install too
    const lines = alibabaLib.split("\n");
    let inEnsureCli = false;
    let commandChecks = 0;
    for (const line of lines) {
      if (line.match(/^ensure_aliyun_cli\(\)/)) inEnsureCli = true;
      if (inEnsureCli && line.includes("command -v aliyun")) commandChecks++;
      if (inEnsureCli && line.match(/^}/)) break;
    }
    expect(commandChecks).toBeGreaterThanOrEqual(2);
  });

  it("should show helpful error messages on CLI installation failure", () => {
    expect(alibabaLib).toContain(
      "https://www.alibabacloud.com/help/en/cli"
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Credential handling
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud credential handling", () => {
  it("should use ALIYUN_ACCESS_KEY_ID as the env var for key ID", () => {
    expect(alibabaLib).toContain("ALIYUN_ACCESS_KEY_ID");
  });

  it("should use ALIYUN_ACCESS_KEY_SECRET as the env var for key secret", () => {
    expect(alibabaLib).toContain("ALIYUN_ACCESS_KEY_SECRET");
  });

  it("should use ALIYUN_REGION with default cn-hangzhou", () => {
    expect(alibabaLib).toContain("ALIYUN_REGION:-cn-hangzhou");
  });

  it("should save credentials to ~/.config/spawn/alibabacloud.json", () => {
    expect(alibabaLib).toContain("alibabacloud.json");
  });

  it("should use _load_json_config_fields to load from config file", () => {
    expect(alibabaLib).toContain("_load_json_config_fields");
  });

  it("should use _save_json_config to save credentials", () => {
    expect(alibabaLib).toContain("_save_json_config");
  });

  it("should point users to the correct access key management URL", () => {
    expect(alibabaLib).toContain("ram.console.aliyun.com/manage/ak");
  });

  it("should test credentials by calling DescribeRegions", () => {
    expect(alibabaLib).toContain("DescribeRegions");
  });

  it("should configure aliyun CLI with AK mode", () => {
    expect(alibabaLib).toContain("--mode AK");
  });

  it("should use safe_read for prompting credentials", () => {
    expect(alibabaLib).toContain("safe_read");
  });

  it("should show helpful error messages on credential failure", () => {
    expect(alibabaLib).toContain("ECS permissions");
    expect(alibabaLib).toContain("How to fix:");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH key management
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud SSH key management", () => {
  it("should use ensure_ssh_key_with_provider for SSH key lifecycle", () => {
    expect(alibabaLib).toContain("ensure_ssh_key_with_provider");
  });

  it("should define check and register callbacks for SSH keys", () => {
    expect(alibabaFunctions).toContain("aliyun_check_ssh_key");
    expect(alibabaFunctions).toContain("aliyun_register_ssh_key");
  });

  it("should pass provider name 'Alibaba Cloud' to ensure_ssh_key_with_provider", () => {
    const lines = alibabaLib.split("\n");
    let inEnsure = false;
    let found = false;
    for (const line of lines) {
      if (line.match(/^ensure_ssh_key\(\)/)) inEnsure = true;
      if (inEnsure && line.includes('"Alibaba Cloud"')) found = true;
      if (inEnsure && line.match(/^}/)) break;
    }
    expect(found).toBe(true);
  });

  it("should use DescribeKeyPairs for checking SSH keys", () => {
    expect(alibabaLib).toContain("DescribeKeyPairs");
  });

  it("should use ImportKeyPair for registering SSH keys", () => {
    expect(alibabaLib).toContain("ImportKeyPair");
  });

  it("should show helpful error messages on SSH key registration failure", () => {
    expect(alibabaLib).toContain("SSH key already registered");
    expect(alibabaLib).toContain("Invalid SSH key format");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Server lifecycle
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud server lifecycle", () => {
  it("should use aliyun ecs RunInstances for server creation", () => {
    expect(alibabaLib).toContain("RunInstances");
  });

  it("should configure VPC before creating instances", () => {
    expect(alibabaLib).toContain("DescribeVpcs");
    expect(alibabaLib).toContain("CreateVpc");
  });

  it("should configure vSwitch within VPC", () => {
    expect(alibabaLib).toContain("DescribeVSwitches");
    expect(alibabaLib).toContain("CreateVSwitch");
  });

  it("should configure security group with SSH access", () => {
    expect(alibabaLib).toContain("CreateSecurityGroup");
    expect(alibabaLib).toContain("AuthorizeSecurityGroup");
    expect(alibabaLib).toContain("22/22");
  });

  it("should use get_cloud_init_userdata for instance initialization", () => {
    expect(alibabaLib).toContain("get_cloud_init_userdata");
  });

  it("should base64-encode userdata for RunInstances", () => {
    expect(alibabaLib).toContain("base64");
  });

  it("should store instance ID in ALIYUN_INSTANCE_ID", () => {
    expect(alibabaLib).toContain("ALIYUN_INSTANCE_ID");
    expect(alibabaLib).toContain("export ALIYUN_INSTANCE_ID");
  });

  it("should store instance IP in ALIYUN_INSTANCE_IP", () => {
    expect(alibabaLib).toContain("ALIYUN_INSTANCE_IP");
    expect(alibabaLib).toContain("export ALIYUN_INSTANCE_IP");
  });

  it("should start instance after creation", () => {
    expect(alibabaLib).toContain("StartInstance");
  });

  it("should poll instance status until Running", () => {
    expect(alibabaLib).toContain('"Running"');
  });

  it("should extract public IP from instance response", () => {
    expect(alibabaLib).toContain("PublicIpAddress");
    expect(alibabaLib).toContain("IpAddress");
  });

  it("should use configurable INSTANCE_STATUS_POLL_DELAY", () => {
    expect(alibabaLib).toContain("INSTANCE_STATUS_POLL_DELAY");
  });

  it("should have sensible defaults for instance type, region, and image", () => {
    expect(alibabaLib).toContain("ecs.t5-lc1m2.small"); // default instance type
    expect(alibabaLib).toContain("cn-hangzhou"); // default region
    expect(alibabaLib).toContain("ubuntu_24_04"); // Ubuntu 24.04 image
  });

  it("should validate env vars with validate_resource_name before server creation", () => {
    const createLines = alibabaLib.split("\n");
    let inCreate = false;
    let validations = 0;
    for (const line of createLines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("validate_resource_name")) validations++;
      if (inCreate && line.includes("validate_region_name")) validations++;
      if (inCreate && line.includes("_aliyun_validate_create_params")) validations++; // Combined validation function
      if (inCreate && line.match(/^}/)) break;
    }
    // Should validate instance_type and region (directly or via _aliyun_validate_create_params)
    expect(validations).toBeGreaterThanOrEqual(1);
  });

  it("should show helpful error messages on server creation failure", () => {
    expect(alibabaLib).toContain("Insufficient quota");
    expect(alibabaLib).toContain("Invalid instance type");
  });

  it("should use get_validated_server_name for server name input", () => {
    expect(alibabaLib).toContain("get_validated_server_name");
  });

  it("should use python3 for safe JSON parsing of API responses", () => {
    // Multiple python3 calls for parsing JSON responses
    const python3Count = (alibabaLib.match(/python3 -c/g) || []).length;
    expect(python3Count).toBeGreaterThanOrEqual(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security group management
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud security group management", () => {
  it("should check for existing security group before creating", () => {
    expect(alibabaLib).toContain("DescribeSecurityGroups");
  });

  it("should use a spawn-default security group name", () => {
    expect(alibabaLib).toContain("spawn-default");
  });

  it("should allow configuring security group name via env var", () => {
    expect(alibabaLib).toContain("ALIYUN_SECURITY_GROUP_NAME");
  });

  it("should open SSH port 22 in security group", () => {
    expect(alibabaLib).toContain("IpProtocol tcp");
    expect(alibabaLib).toContain("22/22");
    expect(alibabaLib).toContain("0.0.0.0/0");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SSH delegation pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud SSH delegation pattern", () => {
  it("should delegate verify_server_connectivity to ssh_verify_connectivity", () => {
    expect(alibabaLib).toContain("ssh_verify_connectivity");
  });

  it("should use scp for upload_file or delegate to shared SSH", () => {
    const hasScp = alibabaLib.includes("scp");
    const hasSshUpload = alibabaLib.includes("ssh_upload_file");
    const hasSSHOpts = alibabaLib.includes("SSH_OPTS");
    // Either uses scp with SSH_OPTS, or delegates to ssh_upload_file
    expect((hasScp && hasSSHOpts) || hasSshUpload).toBe(true);
  });

  it("should use ssh for run_server or delegate to shared SSH", () => {
    const runLines = alibabaLib.split("\n");
    let inRun = false;
    let usesSSH = false;
    for (const line of runLines) {
      if (line.match(/^run_server\(\)/)) inRun = true;
      if (inRun && (line.includes("ssh ") || line.includes("ssh_run_server"))) usesSSH = true;
      if (inRun && line.match(/^}/)) break;
    }
    expect(usesSSH).toBe(true);
  });

  it("should use ssh -t for interactive_session or delegate to shared SSH", () => {
    const sessionLines = alibabaLib.split("\n");
    let inSession = false;
    let usesSSHT = false;
    for (const line of sessionLines) {
      if (line.match(/^interactive_session\(\)/)) inSession = true;
      if (inSession && ((line.includes("ssh") && line.includes("-t")) || line.includes("ssh_interactive_session"))) usesSSHT = true;
      if (inSession && line.match(/^}/)) break;
    }
    expect(usesSSHT).toBe(true);
  });

  it("should connect as root user or delegate to shared SSH", () => {
    const hasRoot = alibabaLib.includes("root@");
    const delegatesToSSH = alibabaLib.includes("ssh_run_server") || alibabaLib.includes("ssh_interactive_session");
    expect(hasRoot || delegatesToSSH).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent script patterns
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud agent script patterns", () => {
  it("should have at least 3 implemented agent scripts", () => {
    expect(alibabaEntries.length).toBeGreaterThanOrEqual(3);
  });

  for (const { key, agent, path } of alibabaEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source alibabacloud/lib/common.sh with fallback", () => {
        expect(content).toContain("alibabacloud/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should use set -eo pipefail", () => {
        expect(content).toContain("set -eo pipefail");
      });

      it("should call ensure_aliyun_credentials", () => {
        expect(
          codeLines.some((l) => l.includes("ensure_aliyun_credentials"))
        ).toBe(true);
      });

      it("should call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(true);
      });

      it("should call get_server_name and create_server", () => {
        expect(codeLines.some((l) => l.includes("get_server_name"))).toBe(
          true
        );
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call verify_server_connectivity with ALIYUN_INSTANCE_IP", () => {
        expect(
          codeLines.some((l) => l.includes("verify_server_connectivity"))
        ).toBe(true);
        expect(
          codeLines.some((l) => l.includes("ALIYUN_INSTANCE_IP"))
        ).toBe(true);
      });

      it("should call wait_for_cloud_init with ALIYUN_INSTANCE_IP", () => {
        expect(
          codeLines.some((l) => l.includes("wait_for_cloud_init"))
        ).toBe(true);
        const waitLines = codeLines.filter((l) =>
          l.includes("wait_for_cloud_init")
        );
        expect(waitLines.some((l) => l.includes("ALIYUN_INSTANCE_IP"))).toBe(
          true
        );
      });

      it("should reference OPENROUTER_API_KEY", () => {
        expect(
          codeLines.some((l) => l.includes("OPENROUTER_API_KEY"))
        ).toBe(true);
      });

      it("should handle OPENROUTER_API_KEY from env or OAuth", () => {
        expect(content).toContain("OPENROUTER_API_KEY:-");
        expect(content).toContain("get_openrouter_api_key_oauth");
      });

      it("should use inject_env_vars_ssh for env var injection (SSH-based)", () => {
        expect(
          codeLines.some((l) => l.includes("inject_env_vars_ssh"))
        ).toBe(true);
      });

      it("should NOT use inject_env_vars_local (Alibaba Cloud is SSH-based)", () => {
        expect(
          codeLines.some((l) => l.includes("inject_env_vars_local"))
        ).toBe(false);
      });

      it("should pass ALIYUN_INSTANCE_IP to inject_env_vars_ssh", () => {
        const injectLines = codeLines.filter((l) =>
          l.includes("inject_env_vars_ssh")
        );
        expect(
          injectLines.some((l) => l.includes("ALIYUN_INSTANCE_IP"))
        ).toBe(true);
      });

      it("should call interactive_session with ALIYUN_INSTANCE_IP", () => {
        expect(
          codeLines.some((l) => l.includes("interactive_session"))
        ).toBe(true);
        const sessionLines = codeLines.filter((l) =>
          l.includes("interactive_session")
        );
        expect(
          sessionLines.some((l) => l.includes("ALIYUN_INSTANCE_IP"))
        ).toBe(true);
      });

      it("should pass IP to run_server calls", () => {
        const runServerLines = codeLines.filter((l) =>
          l.includes("run_server")
        );
        for (const line of runServerLines) {
          expect(line).toContain("ALIYUN_INSTANCE_IP");
        }
      });

      it("should NOT contain any echo -e (macOS compat)", () => {
        const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
        expect(hasEchoE).toBe(false);
      });

      it("should NOT use set -u", () => {
        const hasSetU = codeLines.some(
          (l) =>
            /\bset\s+.*-[a-z]*u/.test(l) ||
            /\bset\s+-o\s+nounset\b/.test(l)
        );
        expect(hasSetU).toBe(false);
      });
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Agent-specific behavior
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud claude.sh agent-specific patterns", () => {
  const claudePath = join(REPO_ROOT, "alibabacloud", "claude.sh");
  const claudeExists = existsSync(claudePath);
  const claudeContent = claudeExists ? readScript(claudePath) : "";

  it("should exist", () => {
    expect(claudeExists).toBe(true);
  });

  it("should install Claude Code if not present", () => {
    expect(claudeContent).toContain("claude.ai/install.sh");
  });

  it("should set ANTHROPIC_BASE_URL for OpenRouter", () => {
    expect(claudeContent).toContain(
      "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
    );
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
    const sessionLines = codeLines.filter((l) =>
      l.includes("interactive_session")
    );
    expect(sessionLines.some((l) => l.includes("claude"))).toBe(true);
  });
});

describe("Alibaba Cloud codex.sh agent-specific patterns", () => {
  const codexPath = join(REPO_ROOT, "alibabacloud", "codex.sh");
  const codexExists = existsSync(codexPath);
  const codexContent = codexExists ? readScript(codexPath) : "";

  it("should exist", () => {
    expect(codexExists).toBe(true);
  });

  it("should install Codex via npm", () => {
    expect(codexContent).toContain("npm install -g @openai/codex");
  });

  it("should set OPENAI_API_KEY and OPENAI_BASE_URL for OpenRouter", () => {
    expect(codexContent).toContain("OPENAI_API_KEY=");
    expect(codexContent).toContain(
      "OPENAI_BASE_URL=https://openrouter.ai/api/v1"
    );
  });

  it("should launch codex in interactive session", () => {
    const codeLines = getCodeLines(codexContent);
    const sessionLines = codeLines.filter((l) =>
      l.includes("interactive_session")
    );
    expect(sessionLines.some((l) => l.includes("codex"))).toBe(true);
  });
});

describe("Alibaba Cloud gemini.sh agent-specific patterns", () => {
  const geminiPath = join(REPO_ROOT, "alibabacloud", "gemini.sh");
  const geminiExists = existsSync(geminiPath);
  const geminiContent = geminiExists ? readScript(geminiPath) : "";

  it("should exist", () => {
    expect(geminiExists).toBe(true);
  });

  it("should install Gemini CLI via npm", () => {
    expect(geminiContent).toContain("npm install -g @google/gemini-cli");
  });

  it("should set GEMINI_API_KEY for OpenRouter", () => {
    expect(geminiContent).toContain("GEMINI_API_KEY=");
  });

  it("should set OPENAI_BASE_URL for OpenRouter", () => {
    expect(geminiContent).toContain(
      "OPENAI_BASE_URL=https://openrouter.ai/api/v1"
    );
  });

  it("should launch gemini in interactive session", () => {
    const codeLines = getCodeLines(geminiContent);
    const sessionLines = codeLines.filter((l) =>
      l.includes("interactive_session")
    );
    expect(sessionLines.some((l) => l.includes("gemini"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Security conventions
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud security conventions", () => {
  it("should NOT contain echo -e (macOS compatibility)", () => {
    const codeLines = getCodeLines(alibabaLib);
    const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
    expect(hasEchoE).toBe(false);
  });

  it("should NOT use set -u (nounset)", () => {
    const codeLines = getCodeLines(alibabaLib);
    const hasSetU = codeLines.some(
      (l) =>
        /\bset\s+.*-[a-z]*u/.test(l) || /\bset\s+-o\s+nounset\b/.test(l)
    );
    expect(hasSetU).toBe(false);
  });

  it("should use validate_resource_name for env var injection prevention", () => {
    expect(alibabaLib).toContain("validate_resource_name");
  });

  it("should use validate_region_name for region validation", () => {
    expect(alibabaLib).toContain("validate_region_name");
  });

  it("should use python3 for JSON parsing instead of string manipulation", () => {
    // Alibaba Cloud uses python3 -c for all JSON extraction
    expect(alibabaLib).toContain("python3 -c");
    expect(alibabaLib).toContain("json.loads");
  });

  it("should use json.loads for safe JSON parsing (not eval/grep)", () => {
    const codeLines = getCodeLines(alibabaLib);
    // Should not use eval for JSON parsing
    const hasEvalJson = codeLines.some(
      (l) => l.includes("eval") && l.includes("json")
    );
    expect(hasEvalJson).toBe(false);
  });

  it("should use ${VAR:-} pattern for optional env vars", () => {
    expect(alibabaLib).toContain("ALIYUN_ACCESS_KEY_ID:-");
    expect(alibabaLib).toContain("ALIYUN_ACCESS_KEY_SECRET:-");
    expect(alibabaLib).toContain("ALIYUN_REGION:-");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Manifest consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("Manifest consistency for Alibaba Cloud", () => {
  it("alibabacloud should be in manifest.clouds", () => {
    expect(manifest.clouds["alibabacloud"]).toBeDefined();
  });

  it("alibabacloud should have type 'cli'", () => {
    expect(manifest.clouds["alibabacloud"]?.type).toBe("cli");
  });

  it("alibabacloud should have auth set to ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET", () => {
    const auth = manifest.clouds["alibabacloud"]?.auth;
    expect(auth).toContain("ALIYUN_ACCESS_KEY_ID");
    expect(auth).toContain("ALIYUN_ACCESS_KEY_SECRET");
  });

  it("alibabacloud should use SSH exec method", () => {
    expect(manifest.clouds["alibabacloud"]?.exec_method).toContain("ssh");
  });

  it("alibabacloud should use SSH interactive method", () => {
    expect(manifest.clouds["alibabacloud"]?.interactive_method).toContain(
      "ssh"
    );
  });

  it("alibabacloud matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("alibabacloud/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("every alibabacloud/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix).filter(
      ([key, status]) =>
        key.startsWith("alibabacloud/") && status === "implemented"
    );
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });

  it("alibabacloud should have defaults for instance_type, region, and image_id", () => {
    const cloud = manifest.clouds["alibabacloud"];
    expect(cloud?.defaults).toBeDefined();
    if (cloud?.defaults) {
      expect(cloud.defaults.instance_type).toBe("ecs.t5-lc1m2.small");
      expect(cloud.defaults.region).toBe("cn-hangzhou");
      expect(cloud.defaults.image_id).toContain("ubuntu_24_04");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Network infrastructure (VPC / vSwitch / Security Group)
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud network infrastructure setup", () => {
  it("should create VPC with CIDR 172.16.0.0/12 if none exists", () => {
    expect(alibabaLib).toContain("172.16.0.0/12");
  });

  it("should name VPC 'spawn-vpc'", () => {
    expect(alibabaLib).toContain("spawn-vpc");
  });

  it("should create vSwitch with CIDR 172.16.0.0/24 if none exists", () => {
    expect(alibabaLib).toContain("172.16.0.0/24");
  });

  it("should name vSwitch 'spawn-vswitch'", () => {
    expect(alibabaLib).toContain("spawn-vswitch");
  });

  it("should query availability zones for vSwitch placement", () => {
    expect(alibabaLib).toContain("DescribeZones");
  });

  it("should set InternetMaxBandwidthOut for public IP assignment", () => {
    expect(alibabaLib).toContain("InternetMaxBandwidthOut");
  });

  it("should use cloud_efficiency disk category", () => {
    expect(alibabaLib).toContain("cloud_efficiency");
  });

  it("should set SystemDisk.Size to 20 GB", () => {
    expect(alibabaLib).toContain("SystemDisk.Size 20");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Instance polling
// ══════════════════════════════════════════════════════════════════════════════

describe("Alibaba Cloud instance polling", () => {
  it("should use DescribeInstances to check instance status", () => {
    expect(alibabaLib).toContain("DescribeInstances");
  });

  it("should have a configurable max attempts with default 60", () => {
    expect(alibabaLib).toContain("${2:-60}");
  });

  it("should sleep between polling attempts", () => {
    const lines = alibabaLib.split("\n");
    let inWait = false;
    let hasSleep = false;
    for (const line of lines) {
      if (line.match(/^_wait_for_aliyun_instance\(\)/)) inWait = true;
      if (inWait && line.includes("sleep")) hasSleep = true;
      if (inWait && line.match(/^}/)) break;
    }
    expect(hasSleep).toBe(true);
  });

  it("should show progress during polling", () => {
    expect(alibabaLib).toContain("log_step");
    expect(alibabaLib).toContain("attempt");
  });

  it("should show helpful error when instance does not become ready", () => {
    expect(alibabaLib).toContain(
      "Instance did not become ready within expected time"
    );
  });
});
