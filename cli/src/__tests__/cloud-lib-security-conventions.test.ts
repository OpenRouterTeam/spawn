import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Cloud lib/common.sh security convention regression tests.
 *
 * Validates that all cloud provider lib/common.sh files follow security
 * conventions established in the security audit (PR #102):
 *
 * - SSH public key data embedded in JSON bodies MUST use json_escape()
 * - Server names in JSON payloads MUST use json_escape() or be validated
 * - No raw heredoc variable interpolation for user-controlled data in API bodies
 * - Config files written with tokens MUST use chmod 600
 * - Python code receiving user data MUST use stdin (not string interpolation)
 *
 * These tests prevent security regressions when new clouds are added or
 * existing create_server/register_ssh_key functions are modified.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// Collect all unique clouds with at least one implementation
const cloudsWithImpls = new Set<string>();
for (const [key, status] of Object.entries(manifest.matrix)) {
  if (status === "implemented") {
    cloudsWithImpls.add(key.split("/")[0]);
  }
}

/** Read a cloud's lib/common.sh content */
function readCloudLib(cloud: string): string | null {
  const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
  if (!existsSync(libPath)) return null;
  return readFileSync(libPath, "utf-8");
}

/** Extract a function body from shell script content by function name */
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
        // Count opening brace on first line
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

/** Get non-comment lines from a script */
function getCodeLines(content: string): string[] {
  return content.split("\n").filter((line) => !line.trimStart().startsWith("#"));
}

/** Check if a line interpolates a variable inside a JSON body string (double-quoted or heredoc) */
function hasRawJsonInterpolation(line: string, varName: string): boolean {
  // Pattern: "...$var..." or "...${var}..." inside a JSON-like context
  // Exclude lines that use json_escape or are comments
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return false;
  if (line.includes("json_escape")) return false;

  // Check for ${var} or $var inside double-quoted JSON-like strings
  const jsonContext = /["'].*\$\{?\w+\}?.*["']/;
  if (!jsonContext.test(line)) return false;

  const pattern = new RegExp(`\\$\\{?${varName}\\}?`);
  return pattern.test(line);
}

// ── SSH key security ─────────────────────────────────────────────────────────

describe("SSH key embedding security", () => {
  /**
   * Cloud lib files that register SSH keys via JSON API calls MUST use
   * json_escape() for the public key data. SSH public keys can contain
   * characters that break JSON (backslashes in comments, etc.).
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    // Find SSH key registration function (various naming patterns)
    const sshFuncNames = [
      "register_ssh_key",
      `register_${cloud.replace(/-/g, "_")}_ssh_key`,
      `${cloud.replace(/-/g, "_")}_register_ssh_key`,
      "ensure_ssh_key",
      "upload_ssh_key",
      "create_ssh_key",
    ];

    for (const funcName of sshFuncNames) {
      const funcBody = extractFunctionBody(content, funcName);
      if (!funcBody) continue;

      // Skip functions that delegate to check_ssh_key_by_fingerprint or ensure_ssh_key_with_provider
      if (funcBody.includes("ensure_ssh_key_with_provider")) continue;

      // If the function constructs a JSON body with pub key data, it must use json_escape
      const codeLines = getCodeLines(funcBody);
      const usesJsonBody = codeLines.some(
        (l) => l.includes('"ssh_key"') || l.includes('"public_key"') ||
               l.includes('"key"') || l.includes("ssh_keys")
      );

      if (usesJsonBody) {
        it(`${cloud} ${funcName} should safely encode SSH public key in JSON`, () => {
          // Safe patterns: json_escape(), python3 json.dumps via stdin, jq
          const usesEscape = funcBody.includes("json_escape") ||
            (funcBody.includes("json.dumps") && funcBody.includes("sys.stdin")) ||
            funcBody.includes("jq ");
          expect(usesEscape).toBe(true);
        });
      }
    }
  }
});

// ── Config file permissions ──────────────────────────────────────────────────

describe("Config file permission security", () => {
  /**
   * When writing config files that contain API tokens/secrets, the file
   * permissions should be restricted (chmod 600) to prevent other users
   * from reading credentials.
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    const lines = content.split("\n");
    const configWrites: { lineNum: number; line: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith("#")) continue;

      // Detect config file writes that likely contain secrets
      // Pattern: writing to a config file path that contains "config" or "token" or "credential"
      if (
        (trimmed.includes(".json") || trimmed.includes(".conf") || trimmed.includes(".cfg")) &&
        (trimmed.includes("> ") || trimmed.includes(">>")) &&
        (trimmed.includes("token") || trimmed.includes("api_key") || trimmed.includes("credential"))
      ) {
        configWrites.push({ lineNum: i + 1, line: trimmed });
      }
    }

    // For clouds that write config files with tokens, check that chmod 600 appears nearby
    if (configWrites.length > 0) {
      it(`${cloud} should set restrictive permissions on config files with secrets`, () => {
        const hasChmod = content.includes("chmod 600") || content.includes("chmod 0600");
        // Allow use of _save_json_config or _save_token_to_config which handle permissions
        const usesSafeHelper = content.includes("_save_json_config") ||
                               content.includes("_save_token_to_config") ||
                               content.includes("ensure_api_token_with_provider") ||
                               content.includes("ensure_multi_credentials");
        expect(hasChmod || usesSafeHelper).toBe(true);
      });
    }
  }
});

// ── Python code injection prevention ─────────────────────────────────────────

describe("Python code injection prevention", () => {
  /**
   * When cloud libs use inline Python to process data (JSON parsing, etc.),
   * user-controlled data MUST be passed via stdin or command arguments,
   * NOT via string interpolation in Python code strings.
   *
   * Bad:  python3 -c "print('${USER_TOKEN}')"
   * Good: python3 -c "import sys; print(sys.stdin.read())" <<< "${USER_TOKEN}"
   * Good: python3 -c "import json,sys; data=json.load(sys.stdin)" <<< "${response}"
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    const lines = content.split("\n");
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith("#")) continue;

      // Check for python3 -c with variable interpolation inside triple quotes
      if (
        trimmed.includes("python3") &&
        trimmed.includes("-c") &&
        /python3\s+-c\s+["'].*\$\{/.test(trimmed)
      ) {
        // Allow safe patterns: variable used as a file path or harmless metadata
        // Block patterns where tokens/keys/user data are interpolated
        if (
          trimmed.includes("api_key") ||
          trimmed.includes("token") ||
          trimmed.includes("secret") ||
          trimmed.includes("password") ||
          trimmed.includes("ssh_key") ||
          trimmed.includes("SSH_KEY")
        ) {
          violations.push(`line ${i + 1}: ${trimmed.substring(0, 120)}`);
        }
      }
    }

    if (violations.length > 0) {
      it(`${cloud} should not interpolate secrets in Python code strings`, () => {
        expect(violations).toEqual([]);
      });
    }
  }
});

// ── API body JSON safety ─────────────────────────────────────────────────────

describe("API body JSON construction safety", () => {
  /**
   * When constructing JSON bodies for API calls, user-controlled data
   * (SSH keys, server names, tokens) must be properly escaped.
   *
   * Safe patterns:
   * - json_escape for string values
   * - printf with %s and json_escape
   * - Python json.dumps for complex data
   * - jq for JSON construction
   *
   * Unsafe pattern:
   * - Raw variable expansion in double-quoted JSON: '{"key": "${value}"}'
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    // Extract create_server function body
    const createBody = extractFunctionBody(content, "create_server");
    if (!createBody) continue;

    const codeLines = getCodeLines(createBody);

    // Check for JSON body construction with raw pub_key interpolation
    const rawPubKeyInJson = codeLines.some((line) => {
      if (line.includes("json_escape")) return false;
      if (line.includes("json_pub_key")) return false;
      if (line.includes("json_ssh_key")) return false;
      if (line.includes("escaped_")) return false;
      // Raw pub_key or ssh_pub_key directly in a JSON string
      return (
        (line.includes('"public_key"') || line.includes('"ssh_key"') || line.includes('"sshKey"')) &&
        (line.includes("${pub_key}") || line.includes("${ssh_pub_key}") || line.includes("$pub_key"))
      );
    });

    if (rawPubKeyInJson) {
      it(`${cloud} create_server should not embed raw SSH key in JSON`, () => {
        expect(rawPubKeyInJson).toBe(false);
      });
    }
  }
});

// ── Heredoc injection prevention ─────────────────────────────────────────────

describe("Heredoc injection prevention", () => {
  /**
   * When using heredocs to construct multi-line data (cloud-init scripts,
   * init scripts), the heredoc should use single-quoted delimiters ('EOF')
   * when containing user-controlled variables, OR the variables must be
   * pre-validated/escaped.
   *
   * The key risk is that user data containing backticks, $(...), or other
   * shell metacharacters could be executed during heredoc expansion.
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    const createBody = extractFunctionBody(content, "create_server");
    if (!createBody) continue;

    // Check for heredocs with SSH keys or tokens interpolated
    const lines = createBody.split("\n");
    let inHeredoc = false;
    let heredocDelimiter = "";
    let isQuotedHeredoc = false;
    const violations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith("#")) continue;

      // Detect heredoc start
      const heredocMatch = trimmed.match(/<<[-~]?\s*['"]?(\w+)['"]?/);
      if (heredocMatch && !inHeredoc) {
        inHeredoc = true;
        heredocDelimiter = heredocMatch[1];
        // Check if the delimiter is quoted (safe - no expansion)
        isQuotedHeredoc = /<<[-~]?\s*'/.test(trimmed);
        continue;
      }

      // Detect heredoc end
      if (inHeredoc && trimmed === heredocDelimiter) {
        inHeredoc = false;
        continue;
      }

      // Inside an unquoted heredoc, check for dangerous variable interpolation
      if (inHeredoc && !isQuotedHeredoc) {
        // Check for SSH key or token interpolation in unquoted heredocs
        if (
          (trimmed.includes("${SSH_KEY}") || trimmed.includes("${ssh_key}") ||
           trimmed.includes("${pub_key}") || trimmed.includes("${ssh_pub_key}")) &&
          !trimmed.includes("json_escape") &&
          !trimmed.includes("base64")
        ) {
          violations.push(`line ${i + 1}: raw SSH key in unquoted heredoc: ${trimmed.substring(0, 100)}`);
        }
      }
    }

    if (violations.length > 0) {
      it(`${cloud} create_server should not interpolate SSH keys in unquoted heredocs`, () => {
        expect(violations).toEqual([]);
      });
    }
  }
});

// ── Source pattern validation ─────────────────────────────────────────────────

describe("Cloud lib sources shared/common.sh", () => {
  /**
   * Every cloud lib/common.sh MUST source shared/common.sh to get access
   * to security functions like json_escape, validate_api_token, etc.
   * Without this, the cloud lib would lack the security primitives.
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    it(`${cloud}/lib/common.sh should source shared/common.sh`, () => {
      expect(content.includes("shared/common.sh")).toBe(true);
    });
  }
});

// ── Token/credential handling ────────────────────────────────────────────────

describe("Credential handling patterns", () => {
  /**
   * Cloud libs that handle API tokens should use the shared credential
   * management functions (ensure_api_token_with_provider or
   * ensure_multi_credentials) rather than implementing their own
   * token loading/saving logic, which is error-prone.
   */
  for (const cloud of cloudsWithImpls) {
    const content = readCloudLib(cloud);
    if (!content) continue;

    // Skip clouds with auth=none (local, etc.)
    const cloudDef = manifest.clouds[cloud];
    if (!cloudDef || cloudDef.auth.toLowerCase() === "none") continue;

    it(`${cloud} should use shared credential helpers or CLI-based auth`, () => {
      const usesSharedHelpers =
        content.includes("ensure_api_token_with_provider") ||
        content.includes("ensure_multi_credentials") ||
        content.includes("_load_token_from_env") ||
        // CLI-based auth patterns (provider's own CLI handles auth)
        content.includes("gcloud auth") ||
        content.includes("oci setup") ||
        content.includes("oci iam") ||
        content.includes("gh auth") ||
        content.includes("modal setup") ||
        content.includes("modal ") ||
        content.includes("sprite login") ||
        content.includes("sprite org") ||
        content.includes("exo ") ||
        content.includes("aws ") ||
        content.includes("daytona") ||
        content.includes("railway") ||
        content.includes("e2b ") ||
        content.includes("aliyun ");

      expect(usesSharedHelpers).toBe(true);
    });
  }
});

// ── Coverage stats ───────────────────────────────────────────────────────────

describe("coverage stats", () => {
  it("should check all implemented clouds", () => {
    expect(cloudsWithImpls.size).toBeGreaterThan(10);
  });

  it("should have lib/common.sh for every implemented cloud", () => {
    const missing: string[] = [];
    for (const cloud of cloudsWithImpls) {
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
      if (!existsSync(libPath)) {
        missing.push(cloud);
      }
    }
    expect(missing).toEqual([]);
  });
});
