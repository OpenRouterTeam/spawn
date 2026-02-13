import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Pattern tests for the Oracle Cloud Infrastructure (OCI) provider.
 *
 * Oracle is a CLI-based cloud provider with:
 * - OCI CLI (oci compute) for instance management
 * - Complex VCN networking setup (VCN -> Internet Gateway -> Route -> Subnet)
 * - Cloud-init userdata for instance bootstrapping
 * - Flex shape support with configurable OCPUs and memory
 * - SSH-based exec (ubuntu@IP)
 * - OCI_COMPARTMENT_ID-based resource scoping
 *
 * These tests validate:
 * 1. lib/common.sh defines the correct provider-specific API surface
 * 2. VCN networking setup is decomposed into focused helpers
 * 3. Agent scripts follow the correct provisioning flow
 * 4. Security conventions are enforced (no echo -e, no set -u)
 * 5. SSH delegation patterns are used correctly
 * 6. OpenRouter env var injection uses SSH-based helpers
 * 7. Manifest consistency
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// -- Helpers ------------------------------------------------------------------

function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

function extractFunctions(content: string): string[] {
  const matches = content.match(/^[_a-z][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

/** Collect implemented entries for Oracle */
function getImplementedEntries() {
  return Object.entries(manifest.matrix)
    .filter(([key, status]) => key.startsWith("oracle/") && status === "implemented")
    .map(([key]) => {
      const agent = key.split("/")[1];
      return { key, agent, path: join(REPO_ROOT, key + ".sh") };
    })
    .filter(({ path }) => existsSync(path));
}

const oracleLibPath = join(REPO_ROOT, "oracle", "lib", "common.sh");
const oracleLib = existsSync(oracleLibPath) ? readScript(oracleLibPath) : "";
const oracleFunctions = extractFunctions(oracleLib);
const oracleEntries = getImplementedEntries();

// =============================================================================
// lib/common.sh API surface
// =============================================================================

describe("Oracle lib/common.sh API surface", () => {
  it("should exist", () => {
    expect(existsSync(oracleLibPath)).toBe(true);
  });

  it("should source shared/common.sh with fallback pattern", () => {
    expect(oracleLib).toContain("shared/common.sh");
    expect(oracleLib).toContain("raw.githubusercontent.com");
    expect(oracleLib).toContain("curl");
  });

  it("should use set -eo pipefail", () => {
    expect(oracleLib).toContain("set -eo pipefail");
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
    "ensure_oci_cli",
    "wait_for_cloud_init",
    "list_servers",
  ];

  for (const fn of requiredFunctions) {
    it(`should define ${fn}()`, () => {
      expect(oracleFunctions).toContain(fn);
    });
  }

  // Oracle-specific internal helpers
  const internalHelpers = [
    "_get_ubuntu_image_id",
    "_get_availability_domain",
    "_create_vcn",
    "_create_internet_gateway",
    "_add_default_route",
    "_add_ssh_security_rules",
    "_setup_vcn_networking",
    "_create_subnet",
    "_get_subnet_id",
    "_get_instance_public_ip",
    "_encode_userdata_b64",
    "_launch_oci_instance",
  ];

  for (const fn of internalHelpers) {
    it(`should define internal helper ${fn}()`, () => {
      expect(oracleFunctions).toContain(fn);
    });
  }
});

// =============================================================================
// OCI CLI dependency
// =============================================================================

describe("Oracle OCI CLI dependency management", () => {
  it("should check for oci CLI with command -v", () => {
    expect(oracleLib).toContain("command -v oci");
  });

  it("should show pip install instructions if OCI CLI is missing", () => {
    expect(oracleLib).toContain("pip install oci-cli");
  });

  it("should show official installer URL as alternative", () => {
    expect(oracleLib).toContain("oracle/oci-cli");
  });

  it("should check for ~/.oci/config existence", () => {
    expect(oracleLib).toContain(".oci/config");
  });

  it("should show oci setup config guidance when config is missing", () => {
    expect(oracleLib).toContain("oci setup config");
  });

  it("should show what credentials are needed in error messages", () => {
    expect(oracleLib).toContain("Tenancy OCID");
    expect(oracleLib).toContain("User OCID");
    expect(oracleLib).toContain("Compartment OCID");
    expect(oracleLib).toContain("Region");
  });

  it("should use OCI_COMPARTMENT_ID for compartment scoping", () => {
    expect(oracleLib).toContain("OCI_COMPARTMENT_ID");
  });

  it("should attempt auto-detection of compartment when env var is not set", () => {
    expect(oracleLib).toContain("oci iam compartment list");
  });

  it("should export OCI_COMPARTMENT_ID after detection", () => {
    expect(oracleLib).toContain('export OCI_COMPARTMENT_ID');
  });
});

// =============================================================================
// VCN networking setup (decomposed helpers)
// =============================================================================

describe("Oracle VCN networking setup", () => {
  it("should create VCN with 10.0.0.0/16 CIDR", () => {
    expect(oracleLib).toContain("10.0.0.0/16");
  });

  it("should use oci network vcn create for VCN creation", () => {
    expect(oracleLib).toContain("oci network vcn create");
  });

  it("should name VCN as spawn-vcn", () => {
    expect(oracleLib).toContain("spawn-vcn");
  });

  it("should create internet gateway named spawn-igw", () => {
    expect(oracleLib).toContain("spawn-igw");
    expect(oracleLib).toContain("oci network internet-gateway create");
  });

  it("should add default route 0.0.0.0/0 via internet gateway", () => {
    expect(oracleLib).toContain("0.0.0.0/0");
    expect(oracleLib).toContain("oci network route-table update");
  });

  it("should add SSH security rules for port 22", () => {
    expect(oracleLib).toContain("oci network security-list update");
    expect(oracleLib).toContain('"min":22');
    expect(oracleLib).toContain('"max":22');
  });

  it("should create subnet with 10.0.1.0/24 CIDR", () => {
    expect(oracleLib).toContain("10.0.1.0/24");
    expect(oracleLib).toContain("oci network subnet create");
  });

  it("should name subnet as spawn-subnet", () => {
    expect(oracleLib).toContain("spawn-subnet");
  });

  it("should reuse existing public subnet when available", () => {
    expect(oracleLib).toContain("oci network subnet list");
    expect(oracleLib).toContain("prohibit-public-ip-on-vnic");
  });

  it("should compose _setup_vcn_networking from _create_internet_gateway and helpers", () => {
    const lines = oracleLib.split("\n");
    let inSetup = false;
    let callsIgw = false;
    let callsRoute = false;
    let callsSecurity = false;
    for (const line of lines) {
      if (line.match(/^_setup_vcn_networking\(\)/)) inSetup = true;
      if (inSetup && line.includes("_create_internet_gateway")) callsIgw = true;
      if (inSetup && line.includes("_add_default_route")) callsRoute = true;
      if (inSetup && line.includes("_add_ssh_security_rules")) callsSecurity = true;
      if (inSetup && line.match(/^}/)) break;
    }
    expect(callsIgw).toBe(true);
    expect(callsRoute).toBe(true);
    expect(callsSecurity).toBe(true);
  });

  it("should compose _get_subnet_id from _create_vcn and helpers", () => {
    const lines = oracleLib.split("\n");
    let inGetSubnet = false;
    let callsCreateVcn = false;
    let callsSetupNet = false;
    let callsCreateSubnet = false;
    for (const line of lines) {
      if (line.match(/^_get_subnet_id\(\)/)) inGetSubnet = true;
      if (inGetSubnet && line.includes("_create_vcn")) callsCreateVcn = true;
      if (inGetSubnet && line.includes("_setup_vcn_networking")) callsSetupNet = true;
      if (inGetSubnet && line.includes("_create_subnet")) callsCreateSubnet = true;
      if (inGetSubnet && line.match(/^}/)) break;
    }
    expect(callsCreateVcn).toBe(true);
    expect(callsSetupNet).toBe(true);
    expect(callsCreateSubnet).toBe(true);
  });

  it("should show helpful error messages when VCN creation fails", () => {
    expect(oracleLib).toContain("VCN limit exceeded");
    expect(oracleLib).toContain("IAM policies");
  });

  it("should show helpful error messages when subnet creation fails", () => {
    expect(oracleLib).toContain("Subnet limit exceeded");
  });

  it("should wait for AVAILABLE state on VCN resources", () => {
    expect(oracleLib).toContain("--wait-for-state AVAILABLE");
  });
});

// =============================================================================
// Instance creation
// =============================================================================

describe("Oracle instance creation", () => {
  it("should use oci compute instance launch", () => {
    expect(oracleLib).toContain("oci compute instance launch");
  });

  it("should default to VM.Standard.E2.1.Micro shape", () => {
    expect(oracleLib).toContain("VM.Standard.E2.1.Micro");
  });

  it("should allow OCI_SHAPE env var override", () => {
    expect(oracleLib).toContain("OCI_SHAPE");
  });

  it("should handle flex shapes with configurable OCPUs and memory", () => {
    expect(oracleLib).toContain(".Flex");
    expect(oracleLib).toContain("OCI_OCPUS");
    expect(oracleLib).toContain("OCI_MEMORY_GB");
    expect(oracleLib).toContain("memoryInGBs");
  });

  it("should search for Ubuntu 24.04 image", () => {
    expect(oracleLib).toContain("Canonical Ubuntu");
    expect(oracleLib).toContain("24.04");
  });

  it("should fall back to image search without shape filter", () => {
    // _get_ubuntu_image_id tries with shape first, then without
    const lines = oracleLib.split("\n");
    let inGetImage = false;
    let imageListCalls = 0;
    for (const line of lines) {
      if (line.match(/^_get_ubuntu_image_id\(\)/)) inGetImage = true;
      if (inGetImage && line.includes("oci compute image list")) imageListCalls++;
      if (inGetImage && line.match(/^}/)) break;
    }
    expect(imageListCalls).toBeGreaterThanOrEqual(2);
  });

  it("should assign public IP to instance", () => {
    expect(oracleLib).toContain("--assign-public-ip true");
  });

  it("should pass SSH authorized key from ~/.ssh/id_ed25519.pub", () => {
    expect(oracleLib).toContain("--ssh-authorized-keys-file");
    expect(oracleLib).toContain("id_ed25519.pub");
  });

  it("should pass cloud-init userdata via --user-data", () => {
    expect(oracleLib).toContain("--user-data");
  });

  it("should wait for RUNNING state", () => {
    expect(oracleLib).toContain("--wait-for-state RUNNING");
  });

  it("should export OCI_INSTANCE_ID and OCI_SERVER_IP after creation", () => {
    expect(oracleLib).toContain("export OCI_INSTANCE_ID");
    expect(oracleLib).toContain("export OCI_SERVER_IP");
  });

  it("should export OCI_INSTANCE_NAME_ACTUAL after creation", () => {
    expect(oracleLib).toContain("export OCI_INSTANCE_NAME_ACTUAL");
  });

  it("should capture stderr for error reporting on launch failure", () => {
    expect(oracleLib).toContain("mktemp");
    expect(oracleLib).toContain("track_temp_file");
  });

  it("should show helpful error messages on instance launch failure", () => {
    expect(oracleLib).toContain("Service limit (quota) exceeded");
    expect(oracleLib).toContain("Shape not available");
    expect(oracleLib).toContain("Out of host capacity");
  });
});

// =============================================================================
// Instance IP retrieval
// =============================================================================

describe("Oracle instance IP retrieval", () => {
  it("should get VNIC attachment for instance", () => {
    expect(oracleLib).toContain("oci compute vnic-attachment list");
  });

  it("should get public IP from VNIC", () => {
    expect(oracleLib).toContain("oci network vnic get");
    expect(oracleLib).toContain("public-ip");
  });

  it("should show error when VNIC or IP cannot be found", () => {
    expect(oracleLib).toContain("Could not get VNIC for instance");
    expect(oracleLib).toContain("Could not get public IP for instance");
  });
});

// =============================================================================
// Cloud-init userdata
// =============================================================================

describe("Oracle cloud-init userdata", () => {
  it("should install essential packages (curl, git, zsh, python3)", () => {
    expect(oracleLib).toContain("apt-get install");
    expect(oracleLib).toContain("curl");
    expect(oracleLib).toContain("git");
    expect(oracleLib).toContain("zsh");
    expect(oracleLib).toContain("python3");
  });

  it("should install Bun", () => {
    expect(oracleLib).toContain("bun.sh/install");
  });

  it("should install Claude Code", () => {
    expect(oracleLib).toContain("claude.ai/install.sh");
  });

  it("should write .cloud-init-complete marker", () => {
    expect(oracleLib).toContain(".cloud-init-complete");
  });

  it("should run installations as ubuntu user", () => {
    expect(oracleLib).toContain("su - ubuntu");
  });

  it("should encode userdata as base64 (macOS and Linux compatible)", () => {
    expect(oracleLib).toContain("base64 -w0");
    expect(oracleLib).toContain("base64");
  });
});

// =============================================================================
// SSH delegation pattern
// =============================================================================

describe("Oracle SSH delegation pattern", () => {
  it("should set SSH_USER to ubuntu", () => {
    expect(oracleLib).toContain('SSH_USER="ubuntu"');
  });

  it("should delegate verify_server_connectivity to ssh_verify_connectivity", () => {
    expect(oracleLib).toContain("ssh_verify_connectivity");
  });

  it("should delegate run_server to ssh_run_server", () => {
    expect(oracleLib).toContain("ssh_run_server");
  });

  it("should delegate upload_file to ssh_upload_file", () => {
    expect(oracleLib).toContain("ssh_upload_file");
  });

  it("should delegate interactive_session to ssh_interactive_session", () => {
    expect(oracleLib).toContain("ssh_interactive_session");
  });

  it("should use generic_ssh_wait in wait_for_cloud_init", () => {
    expect(oracleLib).toContain("generic_ssh_wait");
  });

  it("should check for .cloud-init-complete marker in wait_for_cloud_init", () => {
    const lines = oracleLib.split("\n");
    let inWait = false;
    let checksMarker = false;
    for (const line of lines) {
      if (line.match(/^wait_for_cloud_init\(\)/)) inWait = true;
      if (inWait && line.includes(".cloud-init-complete")) checksMarker = true;
      if (inWait && line.match(/^}/)) break;
    }
    expect(checksMarker).toBe(true);
  });
});

// =============================================================================
// Server destruction
// =============================================================================

describe("Oracle server destruction", () => {
  it("should use oci compute instance terminate", () => {
    expect(oracleLib).toContain("oci compute instance terminate");
  });

  it("should not preserve boot volume on termination", () => {
    expect(oracleLib).toContain("--preserve-boot-volume false");
  });

  it("should accept instance_id parameter or fall back to OCI_INSTANCE_ID", () => {
    const lines = oracleLib.split("\n");
    let inDestroy = false;
    let usesParam = false;
    let usesEnvFallback = false;
    for (const line of lines) {
      if (line.match(/^destroy_server\(\)/)) inDestroy = true;
      if (inDestroy && line.includes("${1:-")) usesParam = true;
      if (inDestroy && line.includes("OCI_INSTANCE_ID")) usesEnvFallback = true;
      if (inDestroy && line.match(/^}/)) break;
    }
    expect(usesParam).toBe(true);
    expect(usesEnvFallback).toBe(true);
  });
});

// =============================================================================
// list_servers
// =============================================================================

describe("Oracle list_servers", () => {
  it("should use oci compute instance list", () => {
    expect(oracleLib).toContain("oci compute instance list");
  });

  it("should filter out TERMINATED instances", () => {
    expect(oracleLib).toContain("TERMINATED");
  });

  it("should display as table", () => {
    expect(oracleLib).toContain("--output table");
  });

  it("should show instance name, state, shape, and creation time", () => {
    expect(oracleLib).toContain("display-name");
    expect(oracleLib).toContain("lifecycle-state");
    expect(oracleLib).toContain("shape");
    expect(oracleLib).toContain("time-created");
  });
});

// =============================================================================
// Availability domain
// =============================================================================

describe("Oracle availability domain handling", () => {
  it("should use oci iam availability-domain list", () => {
    expect(oracleLib).toContain("oci iam availability-domain list");
  });

  it("should use first available domain by default", () => {
    expect(oracleLib).toContain("data[0].name");
  });

  it("should show error when no availability domains found", () => {
    expect(oracleLib).toContain("Could not list availability domains");
  });
});

// =============================================================================
// Security conventions
// =============================================================================

describe("Oracle security conventions", () => {
  it("should NOT contain echo -e (macOS compatibility)", () => {
    const codeLines = getCodeLines(oracleLib);
    const hasEchoE = codeLines.some((l) => /\becho\s+-e\b/.test(l));
    expect(hasEchoE).toBe(false);
  });

  it("should NOT use set -u (nounset)", () => {
    const codeLines = getCodeLines(oracleLib);
    const hasSetU = codeLines.some(
      (l) => /\bset\s+.*-[a-z]*u/.test(l) || /\bset\s+-o\s+nounset\b/.test(l)
    );
    expect(hasSetU).toBe(false);
  });

  it("should use ${VAR:-} pattern for optional env var checks", () => {
    // Key optional env vars should use :- pattern
    expect(oracleLib).toContain("OCI_COMPARTMENT_ID:-");
    expect(oracleLib).toContain("OCI_SUBNET_ID:-");
  });

  it("should use get_resource_name for server name input (sanitization)", () => {
    expect(oracleLib).toContain("get_resource_name");
  });

  it("should use generate_ssh_key_if_missing for SSH key creation", () => {
    expect(oracleLib).toContain("generate_ssh_key_if_missing");
  });

  it("should define configurable INSTANCE_STATUS_POLL_DELAY", () => {
    expect(oracleLib).toContain("INSTANCE_STATUS_POLL_DELAY");
  });
});

// =============================================================================
// create_server decomposition
// =============================================================================

describe("Oracle create_server decomposition", () => {
  it("should delegate image lookup to _get_ubuntu_image_id", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesImage = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_get_ubuntu_image_id")) delegatesImage = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesImage).toBe(true);
  });

  it("should delegate AD lookup to _get_availability_domain", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesAD = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_get_availability_domain")) delegatesAD = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesAD).toBe(true);
  });

  it("should delegate subnet lookup to _get_subnet_id", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesSubnet = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_get_subnet_id")) delegatesSubnet = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesSubnet).toBe(true);
  });

  it("should delegate userdata encoding to _encode_userdata_b64", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesUserdata = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_encode_userdata_b64")) delegatesUserdata = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesUserdata).toBe(true);
  });

  it("should delegate instance launch to _launch_oci_instance", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesLaunch = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_launch_oci_instance")) delegatesLaunch = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesLaunch).toBe(true);
  });

  it("should delegate IP retrieval to _get_instance_public_ip", () => {
    const lines = oracleLib.split("\n");
    let inCreate = false;
    let delegatesIP = false;
    for (const line of lines) {
      if (line.match(/^create_server\(\)/)) inCreate = true;
      if (inCreate && line.includes("_get_instance_public_ip")) delegatesIP = true;
      if (inCreate && line.match(/^}/)) break;
    }
    expect(delegatesIP).toBe(true);
  });
});

// =============================================================================
// Agent script patterns
// =============================================================================

describe("Oracle agent script patterns", () => {
  it("should have at least 10 implemented agent scripts", () => {
    expect(oracleEntries.length).toBeGreaterThanOrEqual(10);
  });

  for (const { key, agent, path } of oracleEntries) {
    const content = readScript(path);
    const codeLines = getCodeLines(content);

    describe(`${key}.sh`, () => {
      it("should source oracle/lib/common.sh with fallback", () => {
        expect(content).toContain("oracle/lib/common.sh");
        expect(content).toContain("raw.githubusercontent.com");
      });

      it("should use set -eo pipefail", () => {
        expect(content).toContain("set -eo pipefail");
      });

      it("should call ensure_oci_cli", () => {
        expect(codeLines.some((l) => l.includes("ensure_oci_cli"))).toBe(true);
      });

      it("should call ensure_ssh_key", () => {
        expect(codeLines.some((l) => l.includes("ensure_ssh_key"))).toBe(true);
      });

      it("should call get_server_name and create_server", () => {
        expect(codeLines.some((l) => l.includes("get_server_name"))).toBe(true);
        expect(codeLines.some((l) => l.includes("create_server"))).toBe(true);
      });

      it("should call verify_server_connectivity with OCI_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("verify_server_connectivity"))).toBe(true);
        expect(codeLines.some((l) => l.includes("OCI_SERVER_IP"))).toBe(true);
      });

      it("should call wait_for_cloud_init with OCI_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("wait_for_cloud_init"))).toBe(true);
        const waitLines = codeLines.filter((l) => l.includes("wait_for_cloud_init"));
        expect(waitLines.some((l) => l.includes("OCI_SERVER_IP"))).toBe(true);
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

      it("should NOT use inject_env_vars_local (Oracle is SSH-based)", () => {
        expect(codeLines.some((l) => l.includes("inject_env_vars_local"))).toBe(false);
      });

      it("should pass OCI_SERVER_IP to inject_env_vars_ssh", () => {
        const injectLines = codeLines.filter((l) => l.includes("inject_env_vars_ssh"));
        expect(injectLines.some((l) => l.includes("OCI_SERVER_IP"))).toBe(true);
      });

      it("should call interactive_session with OCI_SERVER_IP", () => {
        expect(codeLines.some((l) => l.includes("interactive_session"))).toBe(true);
        const sessionLines = codeLines.filter((l) => l.includes("interactive_session"));
        expect(sessionLines.some((l) => l.includes("OCI_SERVER_IP"))).toBe(true);
      });

      it("should pass IP to run_server calls", () => {
        const runServerLines = codeLines.filter((l) => l.includes("run_server"));
        for (const line of runServerLines) {
          expect(line).toContain("OCI_SERVER_IP");
        }
      });

      it("should NOT contain echo -e (macOS compat)", () => {
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

// =============================================================================
// Agent-specific behavior
// =============================================================================

describe("Oracle claude.sh agent-specific patterns", () => {
  const claudePath = join(REPO_ROOT, "oracle", "claude.sh");
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

describe("Oracle aider.sh agent-specific patterns", () => {
  const aiderPath = join(REPO_ROOT, "oracle", "aider.sh");
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

describe("Oracle cline.sh agent-specific patterns", () => {
  const clinePath = join(REPO_ROOT, "oracle", "cline.sh");
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

// =============================================================================
// Manifest consistency
// =============================================================================

describe("Manifest consistency for Oracle", () => {
  it("oracle should be in manifest.clouds", () => {
    expect(manifest.clouds["oracle"]).toBeDefined();
  });

  it("oracle should have type 'cli'", () => {
    expect(manifest.clouds["oracle"]?.type).toBe("cli");
  });

  it("oracle should use SSH exec method", () => {
    expect(manifest.clouds["oracle"]?.exec_method).toContain("ssh");
  });

  it("oracle should use SSH interactive method", () => {
    expect(manifest.clouds["oracle"]?.interactive_method).toContain("ssh");
  });

  it("oracle should have defaults for shape and image", () => {
    const cloud = manifest.clouds["oracle"];
    expect(cloud?.defaults).toBeDefined();
    if (cloud?.defaults) {
      expect(cloud.defaults.shape).toBe("VM.Standard.E2.1.Micro");
      expect(cloud.defaults.image).toBe("Ubuntu 24.04");
    }
  });

  it("oracle matrix entries should all be 'implemented' or 'missing'", () => {
    const entries = Object.entries(manifest.matrix).filter(([key]) =>
      key.startsWith("oracle/")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [, status] of entries) {
      expect(["implemented", "missing"]).toContain(status);
    }
  });

  it("every oracle/implemented entry should have a .sh file on disk", () => {
    const impl = Object.entries(manifest.matrix).filter(
      ([key, status]) => key.startsWith("oracle/") && status === "implemented"
    );
    for (const [key] of impl) {
      const scriptPath = join(REPO_ROOT, key + ".sh");
      expect(existsSync(scriptPath)).toBe(true);
    }
  });

  it("should have at least 10 implemented matrix entries", () => {
    const impl = Object.entries(manifest.matrix).filter(
      ([key, status]) => key.startsWith("oracle/") && status === "implemented"
    );
    expect(impl.length).toBeGreaterThanOrEqual(10);
  });
});
