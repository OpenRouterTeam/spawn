import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Cloud lib/common.sh API surface contract tests.
 *
 * Every cloud provider's lib/common.sh defines a set of functions that
 * agent scripts depend on. This test validates that each cloud lib:
 *
 * 1. Sources shared/common.sh (the load-bearing pattern for curl|bash)
 * 2. Defines the required functions for its cloud type (SSH-based vs CLI-based)
 * 3. Uses proper function signatures (no accidental renames or removals)
 * 4. Has consistent function naming patterns (cloud-prefixed API wrappers)
 * 5. Doesn't use banned patterns (echo -e, set -u, source <())
 *
 * These tests catch:
 * - New clouds added with incomplete API surfaces
 * - Refactors that accidentally remove or rename required functions
 * - Cloud libs that forget to source shared/common.sh
 * - Inconsistent patterns between SSH-based and CLI/sandbox-based providers
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// Collect all clouds that have at least one implemented agent
const cloudsWithImpls = new Set<string>();
for (const [key, status] of Object.entries(manifest.matrix)) {
  if (status === "implemented") {
    cloudsWithImpls.add(key.split("/")[0]);
  }
}

const allClouds = Object.keys(manifest.clouds);

/** Read a cloud's lib/common.sh content, or null if it doesn't exist */
function readCloudLib(cloud: string): string | null {
  const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
  if (!existsSync(libPath)) return null;
  return readFileSync(libPath, "utf-8");
}

/** Extract all function names defined in a shell script */
function extractFunctionNames(content: string): string[] {
  const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
  return matches ? matches.map((m) => m.replace("()", "")) : [];
}

/** Get non-comment, non-empty lines from a script */
function getCodeLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/** Check if a cloud's exec method is SSH-based */
function isSSHBased(cloud: string): boolean {
  const c = manifest.clouds[cloud];
  return c.exec_method.startsWith("ssh ");
}

/** Check if a cloud is a sandbox/container provider (non-SSH) */
function isSandboxOrContainer(cloud: string): boolean {
  const c = manifest.clouds[cloud];
  return (
    c.type === "sandbox" ||
    !c.exec_method.startsWith("ssh ")
  );
}

/** Check if a function name matches a pattern, allowing cloud-prefixed variants.
 *  e.g. hasFunctionOrVariant(fns, "run_server", "ovh") matches "run_server" or "run_ovh" */
function hasFunctionOrVariant(functions: string[], baseName: string, cloud: string): boolean {
  if (functions.includes(baseName)) return true;
  // Check for cloud-prefixed variant (e.g. run_ovh, upload_file_sprite)
  const prefix = baseName.replace(/_server$/, "").replace(/_file$/, "");
  const variant1 = `${prefix}_${cloud}`;        // run_ovh, upload_file_ovh
  const variant2 = `${baseName}_${cloud}`;       // upload_file_sprite
  return functions.includes(variant1) || functions.includes(variant2);
}

// ── Required function sets by cloud category ─────────────────────────────

// SSH-based clouds (API or CLI) MUST define these functions because
// every agent script calls them for the standard provisioning flow
const SSH_REQUIRED_FUNCTIONS = [
  "create_server",
  "interactive_session",
  "run_server",
  "upload_file",
  "get_server_name",
];

// Most SSH-based clouds also define these (high coverage but not strictly required
// for all -- e.g. cherry doesn't have destroy_server)
const SSH_COMMON_FUNCTIONS = [
  "destroy_server",
  "verify_server_connectivity",
  "ensure_ssh_key",
];

// All cloud libs must define at least these to be usable
const UNIVERSAL_REQUIRED_FUNCTIONS = [
  "run_server",  // every cloud needs a way to run commands
];

// Sandbox/CLI clouds that don't use SSH have a different API surface
const SANDBOX_REQUIRED_FUNCTIONS = [
  "create_server",
  "run_server",
  "interactive_session",
  "upload_file",
  "get_server_name",
];

// ── Tests ────────────────────────────────────────────────────────────────

describe("Cloud lib/common.sh API surface contracts", () => {
  // ── Shared library sourcing ────────────────────────────────────────

  describe("shared/common.sh sourcing pattern", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;

      it(`${cloud}/lib/common.sh sources shared/common.sh`, () => {
        // Must reference shared/common.sh in either source or eval pattern
        const hasSource = content.includes("shared/common.sh");
        expect(hasSource).toBe(true);
      });

      it(`${cloud}/lib/common.sh uses the local-or-remote fallback pattern`, () => {
        // The fallback pattern uses either source + eval or SCRIPT_DIR check
        const hasLocalCheck =
          content.includes("SCRIPT_DIR") ||
          content.includes("BASH_SOURCE") ||
          content.includes('dirname');
        const hasRemoteFallback =
          content.includes("eval") || content.includes("curl");
        expect(hasLocalCheck || hasRemoteFallback).toBe(true);
      });
    }
  });

  // ── SSH-based cloud function requirements ──────────────────────────

  describe("SSH-based cloud required functions", () => {
    const sshClouds = Array.from(cloudsWithImpls).filter(
      (c) => manifest.clouds[c] && isSSHBased(c)
    );

    for (const cloud of sshClouds) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      for (const fn of SSH_REQUIRED_FUNCTIONS) {
        it(`${cloud}/lib/common.sh defines ${fn}() or cloud-prefixed variant`, () => {
          // Some clouds (OVH, Sprite) use cloud-prefixed function names
          // e.g. run_ovh instead of run_server, create_ovh_instance instead of create_server
          const hasStandard = functions.includes(fn);
          const hasVariant = hasFunctionOrVariant(functions, fn, cloud);
          // Also check for <action>_<cloud>_<noun> patterns (create_ovh_instance)
          const hasExtendedVariant = functions.some((f) => {
            const prefix = fn.split("_")[0]; // "create", "run", "upload", etc.
            return f.startsWith(`${prefix}_${cloud}`);
          });
          expect(hasStandard || hasVariant || hasExtendedVariant).toBe(true);
        });
      }
    }
  });

  // ── SSH-based cloud common functions (warn on missing) ─────────────

  describe("SSH-based cloud common functions", () => {
    const sshClouds = Array.from(cloudsWithImpls).filter(
      (c) => manifest.clouds[c] && isSSHBased(c)
    );

    for (const cloud of sshClouds) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      it(`${cloud}/lib/common.sh defines most common functions (destroy, verify, ssh)`, () => {
        let missing = 0;
        for (const fn of SSH_COMMON_FUNCTIONS) {
          if (!functions.includes(fn)) missing++;
        }
        // Allow at most 1 missing common function (some clouds have valid reasons)
        expect(missing).toBeLessThanOrEqual(1);
      });
    }
  });

  // ── Sandbox/CLI cloud function requirements ────────────────────────

  describe("sandbox/CLI cloud required functions", () => {
    const nonSshClouds = Array.from(cloudsWithImpls).filter(
      (c) => manifest.clouds[c] && isSandboxOrContainer(c)
    );

    for (const cloud of nonSshClouds) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      // Sandbox/CLI clouds should at minimum have a way to run commands
      // and connect interactively (using standard or cloud-prefixed names)
      it(`${cloud}/lib/common.sh defines run_server() or a run variant`, () => {
        expect(hasFunctionOrVariant(functions, "run_server", cloud)).toBe(true);
      });

      it(`${cloud}/lib/common.sh defines an interactive/session function`, () => {
        // Check for standard or cloud-specific interactive session functions
        const hasInteractive = functions.some(
          (fn) =>
            fn.includes("interactive") ||
            fn.includes("session") ||
            fn.includes("console") ||
            fn.includes("ssh_to") ||
            fn.includes("exec") // sprite exec -tty is handled in agent scripts
        );
        // Some clouds (like sprite) handle interactive sessions directly in
        // agent scripts rather than the lib, so we also check if the lib at
        // least defines the cloud CLI wrapper
        const hasCliWrapper = functions.some(
          (fn) => fn.startsWith(`run_${cloud}`) || fn.startsWith(`${cloud}_`)
        );
        expect(hasInteractive || hasCliWrapper).toBe(true);
      });
    }
  });

  // ── Universal requirements ─────────────────────────────────────────

  describe("all cloud libs define universal functions (or cloud-prefixed variant)", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      for (const fn of UNIVERSAL_REQUIRED_FUNCTIONS) {
        it(`${cloud}/lib/common.sh defines ${fn}() or a cloud-prefixed variant`, () => {
          expect(hasFunctionOrVariant(functions, fn, cloud)).toBe(true);
        });
      }
    }
  });

  // ── Shell script structural requirements ───────────────────────────

  describe("shell script structure", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;

      it(`${cloud}/lib/common.sh starts with #!/bin/bash`, () => {
        expect(content.trimStart().startsWith("#!/bin/bash")).toBe(true);
      });

      it(`${cloud}/lib/common.sh uses set -eo pipefail (or inherits from shared)`, () => {
        // Most libs set this explicitly, but it's also inherited from
        // shared/common.sh when sourced, so either pattern is acceptable
        const hasPipefail = content.includes("set -eo pipefail");
        const sourcesShared = content.includes("shared/common.sh");
        expect(hasPipefail || sourcesShared).toBe(true);
      });

      it(`${cloud}/lib/common.sh does not use echo -e (macOS incompatible)`, () => {
        const codeLines = getCodeLines(content);
        const hasEchoE = codeLines.some(
          (line) => /\becho\s+-e\b/.test(line)
        );
        expect(hasEchoE).toBe(false);
      });

      it(`${cloud}/lib/common.sh does not use set -u or set -o nounset`, () => {
        const codeLines = getCodeLines(content);
        const hasSetU = codeLines.some(
          (line) =>
            /\bset\s+.*-[a-z]*u/.test(line) ||
            /\bset\s+-o\s+nounset\b/.test(line)
        );
        expect(hasSetU).toBe(false);
      });

      it(`${cloud}/lib/common.sh does not use source <() process substitution`, () => {
        const codeLines = getCodeLines(content);
        const hasSourceSubst = codeLines.some(
          (line) => /\bsource\s+<\(/.test(line)
        );
        expect(hasSourceSubst).toBe(false);
      });
    }
  });

  // ── Authentication pattern ─────────────────────────────────────────

  describe("authentication function patterns", () => {
    for (const cloud of cloudsWithImpls) {
      if (cloud === "local") continue; // local has no auth
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      it(`${cloud}/lib/common.sh has an auth/token/credential function`, () => {
        // Every non-local cloud should have some auth function
        const authFunctions = functions.filter(
          (fn) =>
            fn.includes("token") ||
            fn.includes("auth") ||
            fn.includes("credential") ||
            fn.includes("login") ||
            fn.includes("ensure_") ||
            fn.includes("_api")
        );
        expect(authFunctions.length).toBeGreaterThan(0);
      });
    }
  });

  // ── API wrapper function naming ────────────────────────────────────

  describe("API wrapper function naming conventions", () => {
    const apiClouds = Array.from(cloudsWithImpls).filter(
      (c) => manifest.clouds[c]?.type === "api"
    );

    for (const cloud of apiClouds) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      it(`${cloud}/lib/common.sh has a cloud-specific API wrapper function`, () => {
        // API-type clouds have a <cloud>_api() or <cloud>_api_call() function,
        // or use generic_cloud_api/generic_cloud_api_custom_auth from shared
        const hasApiWrapper =
          functions.some((fn) => fn.includes("_api")) ||
          content.includes("generic_cloud_api");
        expect(hasApiWrapper).toBe(true);
      });
    }
  });

  // ── Function count sanity ──────────────────────────────────────────

  describe("function count sanity checks", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      it(`${cloud}/lib/common.sh defines at least 5 functions`, () => {
        expect(functions.length).toBeGreaterThanOrEqual(5);
      });

      it(`${cloud}/lib/common.sh defines no more than 50 functions (not bloated)`, () => {
        expect(functions.length).toBeLessThanOrEqual(50);
      });
    }
  });

  // ── File size sanity ───────────────────────────────────────────────

  describe("file size sanity checks", () => {
    for (const cloud of cloudsWithImpls) {
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
      if (!existsSync(libPath)) continue;
      const content = readFileSync(libPath, "utf-8");
      const lineCount = content.split("\n").length;

      it(`${cloud}/lib/common.sh is at least 50 lines`, () => {
        expect(lineCount).toBeGreaterThanOrEqual(50);
      });

      it(`${cloud}/lib/common.sh is less than 2000 lines (not monolithic)`, () => {
        expect(lineCount).toBeLessThan(2000);
      });
    }
  });

  // ── Cross-reference: agent scripts call functions that exist ───────

  describe("agent scripts reference functions defined in their cloud lib", () => {
    // Sample a few implemented entries to verify agent scripts call
    // functions that actually exist in their cloud's lib/common.sh
    const implemented = Object.entries(manifest.matrix)
      .filter(([, status]) => status === "implemented")
      .map(([key]) => key);

    // Sample up to 30 entries for reasonable test speed
    const sample = implemented.slice(0, 30);

    for (const entry of sample) {
      const [cloud, agent] = entry.split("/");
      const scriptPath = join(REPO_ROOT, entry + ".sh");
      if (!existsSync(scriptPath)) continue;

      const libContent = readCloudLib(cloud);
      if (!libContent) continue;

      const scriptContent = readFileSync(scriptPath, "utf-8");
      const libFunctions = extractFunctionNames(libContent);

      it(`${entry}.sh calls create_server which is defined in ${cloud}/lib`, () => {
        // If the script calls create_server, the lib must define it
        if (scriptContent.includes("create_server")) {
          expect(libFunctions).toContain("create_server");
        }
      });

      it(`${entry}.sh calls run_server which is defined in ${cloud}/lib`, () => {
        if (scriptContent.includes("run_server") || scriptContent.match(new RegExp(`run_${cloud}\\b`))) {
          expect(hasFunctionOrVariant(libFunctions, "run_server", cloud)).toBe(true);
        }
      });

      it(`${entry}.sh calls interactive_session which is defined in ${cloud}/lib`, () => {
        if (scriptContent.includes("interactive_session")) {
          expect(libFunctions).toContain("interactive_session");
        }
      });

      it(`${entry}.sh calls upload_file which is defined in ${cloud}/lib or shared`, () => {
        if (scriptContent.includes("upload_file")) {
          // upload_file may be named upload_file, upload_file_<cloud>, or
          // come from shared/common.sh (upload_config_file, ssh_upload_file)
          const sharedContent = readFileSync(
            join(REPO_ROOT, "shared", "common.sh"),
            "utf-8"
          );
          const sharedFunctions = extractFunctionNames(sharedContent);
          const definedInLib = hasFunctionOrVariant(libFunctions, "upload_file", cloud);
          const definedInShared =
            sharedFunctions.includes("upload_file") ||
            sharedFunctions.includes("ssh_upload_file") ||
            sharedFunctions.includes("upload_config_file");
          expect(definedInLib || definedInShared).toBe(true);
        }
      });
    }
  });

  // ── No duplicate function definitions ──────────────────────────────

  describe("no duplicate function definitions in cloud libs", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;

      it(`${cloud}/lib/common.sh has no duplicate function definitions`, () => {
        const matches = content.match(/^[a-z_][a-z0-9_]*\(\)/gm);
        if (!matches) return;

        const funcNames = matches.map((m) => m.replace("()", ""));
        const seen = new Set<string>();
        const duplicates: string[] = [];

        for (const fn of funcNames) {
          if (seen.has(fn)) {
            duplicates.push(fn);
          }
          seen.add(fn);
        }

        if (duplicates.length > 0) {
          throw new Error(
            `Duplicate functions in ${cloud}/lib/common.sh: ${duplicates.join(", ")}`
          );
        }
      });
    }
  });

  // ── Cloud libs don't redefine shared/common.sh functions ───────────

  describe("cloud libs do not shadow shared/common.sh functions", () => {
    const sharedContent = readFileSync(
      join(REPO_ROOT, "shared", "common.sh"),
      "utf-8"
    );
    const sharedFunctions = extractFunctionNames(sharedContent);

    // These shared functions must never be redefined in cloud libs
    // (they're the core utilities that should be consistent everywhere)
    const protectedFunctions = [
      "log_info",
      "log_warn",
      "log_error",
      "log_step",
      "json_escape",
      "validate_model_id",
      "generic_ssh_wait",
      "generate_ssh_key_if_missing",
      "get_ssh_fingerprint",
      "try_oauth_flow",
      "get_openrouter_api_key_oauth",
      "get_openrouter_api_key_manual",
      "safe_read",
      "open_browser",
    ];

    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);

      it(`${cloud}/lib/common.sh does not redefine protected shared functions`, () => {
        const shadowed = protectedFunctions.filter((fn) =>
          functions.includes(fn)
        );
        if (shadowed.length > 0) {
          throw new Error(
            `${cloud}/lib/common.sh redefines shared functions: ${shadowed.join(", ")}\n` +
            `These are defined in shared/common.sh and should not be overridden.`
          );
        }
      });
    }
  });

  // ── OVH special case (uses function prefixing) ─────────────────────

  describe("OVH cloud special API pattern", () => {
    const content = readCloudLib("ovh");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("OVH lib defines signature-based auth functions", () => {
      // OVH uses a custom auth pattern with signatures
      const hasSigAuth = functions.some(
        (fn) =>
          fn.includes("sign") ||
          fn.includes("ovh_api") ||
          fn.includes("_signature")
      );
      expect(hasSigAuth).toBe(true);
    });
  });

  // ── Sprite special case (CLI-based, no standard SSH) ───────────────

  describe("Sprite cloud special CLI pattern", () => {
    const content = readCloudLib("sprite");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("Sprite lib uses sprite CLI functions", () => {
      const hasSpriteFuncs = functions.some((fn) => fn.includes("sprite"));
      expect(hasSpriteFuncs).toBe(true);
    });

    it("Sprite lib does not define standard SSH functions", () => {
      // Sprite uses its own exec/console commands, not SSH
      expect(functions).not.toContain("ensure_ssh_key");
      expect(functions).not.toContain("verify_server_connectivity");
    });
  });

  // ── Local cloud special case ───────────────────────────────────────

  describe("Local cloud special pattern", () => {
    const content = readCloudLib("local");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("Local lib defines create_server() that runs locally", () => {
      expect(functions).toContain("create_server");
    });

    it("Local lib defines destroy_server()", () => {
      expect(functions).toContain("destroy_server");
    });

    it("Local lib does not define SSH functions", () => {
      expect(functions).not.toContain("ensure_ssh_key");
      expect(functions).not.toContain("verify_server_connectivity");
    });

    it("Local lib defines run_server()", () => {
      expect(functions).toContain("run_server");
    });
  });

  // ── GitHub Codespaces special case ─────────────────────────────────

  describe("GitHub Codespaces special pattern", () => {
    const content = readCloudLib("github-codespaces");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("GitHub Codespaces lib uses gh CLI functions", () => {
      // Should reference gh codespace commands
      expect(content).toContain("gh codespace");
    });

    it("GitHub Codespaces lib defines run_server()", () => {
      expect(functions).toContain("run_server");
    });
  });

  // ── E2B sandbox special case ───────────────────────────────────────

  describe("E2B sandbox special pattern", () => {
    const content = readCloudLib("e2b");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("E2B lib defines sandbox management functions", () => {
      expect(functions).toContain("create_server");
      expect(functions).toContain("destroy_server");
    });

    it("E2B lib does not require SSH", () => {
      expect(functions).not.toContain("ensure_ssh_key");
    });
  });

  // ── Modal sandbox special case ─────────────────────────────────────

  describe("Modal sandbox special pattern", () => {
    const content = readCloudLib("modal");
    if (!content) return;
    const functions = extractFunctionNames(content);

    it("Modal lib defines sandbox management functions", () => {
      expect(functions).toContain("create_server");
      expect(functions).toContain("destroy_server");
    });

    it("Modal lib uses Python SDK", () => {
      // Modal uses Python-based sandbox management
      expect(content).toContain("python");
    });
  });

  // ── Cloud type consistency ─────────────────────────────────────────

  describe("cloud type matches function patterns", () => {
    for (const cloud of cloudsWithImpls) {
      const content = readCloudLib(cloud);
      if (!content) continue;
      const functions = extractFunctionNames(content);
      const cloudDef = manifest.clouds[cloud];

      if (cloudDef.type === "api") {
        it(`API cloud ${cloud} has an API call wrapper`, () => {
          // API clouds have a <cloud>_api, <cloud>_api_call, or similar function,
          // or use generic_cloud_api/generic_cloud_api_custom_auth from shared
          const hasApiFunc =
            functions.some((fn) => fn.includes("_api")) ||
            content.includes("generic_cloud_api");
          expect(hasApiFunc).toBe(true);
        });
      }

      if (cloudDef.exec_method.startsWith("ssh ")) {
        it(`SSH cloud ${cloud} defines verify_server_connectivity or uses generic_ssh_wait`, () => {
          const hasVerify =
            functions.includes("verify_server_connectivity") ||
            content.includes("generic_ssh_wait");
          expect(hasVerify).toBe(true);
        });
      }
    }
  });
});
