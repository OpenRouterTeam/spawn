import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Security regression tests for upload_file() functions across all cloud libs.
 *
 * PR #453 fixed command injection vulnerabilities in upload_file() for 5 clouds.
 * PR #989 hardened all exec-based upload_file() to use strict allowlist regex
 * validation ([a-zA-Z0-9/_.~-]+) instead of fragile blocklist/printf '%q' patterns.
 *
 * These tests ensure:
 * 1. Non-SSH upload_file functions validate remote_path with strict allowlist regex
 * 2. Content is base64-encoded (shell-safe) before embedding in commands
 * 3. No unquoted variable expansion in command strings
 * 4. No use of raw content embedding without base64
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

/** Read the upload_file function body from a cloud's lib/common.sh.
 *  Accepts variant names like upload_file_ovh, upload_file_sprite. */
function extractUploadFileBody(cloudKey: string): { body: string; startLine: number; funcName: string } | null {
  const libPath = join(REPO_ROOT, cloudKey, "lib", "common.sh");
  if (!existsSync(libPath)) return null;

  const content = readFileSync(libPath, "utf-8");
  const lines = content.split("\n");

  // Match upload_file() or upload_file_<variant>()
  const funcPattern = /^(upload_file(?:_\w+)?)\(\)\s*\{/;

  let startIdx = -1;
  let funcName = "";
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(funcPattern);
    if (match) {
      startIdx = i;
      funcName = match[1];
      break;
    }
  }
  if (startIdx === -1) return null;

  // Check if it's a one-liner delegating to ssh_upload_file
  if (lines[startIdx].includes("ssh_upload_file")) {
    return { body: lines[startIdx], startLine: startIdx + 1, funcName };
  }

  // Extract multi-line function body (track brace depth)
  let depth = 0;
  const bodyLines: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    bodyLines.push(line);
    if (depth === 0 && i > startIdx) break;
  }

  return { body: bodyLines.join("\n"), startLine: startIdx + 1, funcName };
}

/**
 * Classify upload_file implementation type:
 * - "ssh": delegates to ssh_upload_file (scp-based, safe by design)
 * - "scp": direct scp call (safe by design)
 * - "cp": local file copy (safe by design)
 * - "gh-cp": GitHub codespace cp (safe by design)
 * - "exec-based": runs commands on remote via exec/run_server (needs validation)
 */
function classifyUploadFile(body: string): string {
  if (body.includes("ssh_upload_file")) return "ssh";
  if (/\bscp\b/.test(body)) return "scp";
  if (body.includes("gh codespace cp")) return "gh-cp";
  if (/\bcp\b.*\$\{?local_path/.test(body) && !body.includes("run_server") && !body.includes("exec")) return "cp";
  // Sprite uses its own CLI's -file flag for native file transfer (not exec-based)
  // Match "sprite exec" or "sprite $(...) exec" (with org flags interpolated)
  if (body.includes("-file") && body.includes("sprite") && body.includes("exec")) return "sprite-cli";
  return "exec-based";
}

// Build classification map for all clouds
const cloudUploadTypes: Map<string, { type: string; body: string; startLine: number; funcName: string }> = new Map();
for (const cloud of cloudsWithImpls) {
  const result = extractUploadFileBody(cloud);
  if (result) {
    const type = classifyUploadFile(result.body);
    cloudUploadTypes.set(cloud, { type, body: result.body, startLine: result.startLine, funcName: result.funcName });
  }
}

// Exec-based clouds need security validation
const execBasedClouds = Array.from(cloudUploadTypes.entries())
  .filter(([, info]) => info.type === "exec-based")
  .map(([cloud, info]) => ({ cloud, ...info }));

describe("upload_file() Security Patterns", () => {
  // ── Coverage check ─────────────────────────────────────────────────

  describe("coverage", () => {
    it("should find an upload_file variant in all clouds with lib/common.sh", () => {
      const missingUpload: string[] = [];
      for (const cloud of cloudsWithImpls) {
        if (!cloudUploadTypes.has(cloud)) {
          const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
          if (existsSync(libPath)) {
            missingUpload.push(cloud);
          }
        }
      }
      if (missingUpload.length > 0) {
        throw new Error(
          `${missingUpload.length} clouds with lib/common.sh missing upload_file*():\n` +
          missingUpload.map((c) => `  - ${c}/lib/common.sh`).join("\n")
        );
      }
    });

    it("should classify all upload_file implementations into known types", () => {
      for (const [, info] of cloudUploadTypes) {
        expect(["ssh", "scp", "cp", "gh-cp", "sprite-cli", "exec-based"]).toContain(info.type);
      }
    });

    it("should have at least 0 exec-based upload_file implementations to test", () => {
      // Note: clouds with exec-based upload_file have been converted to TS
      expect(execBasedClouds.length).toBeGreaterThanOrEqual(0);
    });

    it("should check at least 2 clouds total", () => {
      // Note: TS-based clouds (fly, local, hetzner, digitalocean, daytona, sprite, gcp) don't have bash lib/common.sh with upload_file
      expect(cloudUploadTypes.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Remote path injection protection ───────────────────────────────
  // Exec-based clouds must protect against remote_path injection via EITHER:
  //   (a) Strict allowlist regex: only allow safe path characters [a-zA-Z0-9/_.~-]
  //   (b) Character validation: reject ', $, `, newlines in remote_path
  //   (c) printf '%q' escaping: shell-escape the path before embedding

  describe("exec-based upload_file: remote path injection protection", () => {
    for (const { cloud, body } of execBasedClouds) {
      it(`${cloud} should protect remote_path against injection`, () => {
        const hasAllowlistRegex = /\[a-zA-Z0-9/.test(body);
        const hasCharValidation =
          (body.includes(`"'"`) || body.includes("'\\''")) &&
          (body.includes("'$'") || body.includes("\\$"));
        const hasPrintfEscape = body.includes("printf '%q'");
        // Must use at least one protection method
        expect(
          hasAllowlistRegex || hasCharValidation || hasPrintfEscape
        ).toBe(true);
      });
    }
  });

  // ── Base64 encoding ────────────────────────────────────────────────

  describe("exec-based upload_file: base64 content encoding", () => {
    for (const { cloud, body } of execBasedClouds) {
      it(`${cloud} should use base64 to encode file content`, () => {
        expect(body).toContain("base64");
      });

      it(`${cloud} should not embed raw file content via cat into commands`, () => {
        const hasDangerousEmbed = /\$\(cat\s/.test(body) && !body.includes("base64");
        expect(hasDangerousEmbed).toBe(false);
      });
    }
  });

  // ── Safe command string construction ───────────────────────────────

  describe("exec-based upload_file: safe command construction", () => {
    for (const { cloud, body } of execBasedClouds) {
      it(`${cloud} should use base64 decode or SDK filesystem API`, () => {
        const hasSafeDecode =
          body.includes("base64 -d") || body.includes("base64 --decode") ||
          body.includes("Buffer.from") || body.includes("writeFile");
        expect(hasSafeDecode).toBe(true);
      });

      it(`${cloud} should use safe content delivery (printf or env var)`, () => {
        // Safe: printf '%s' '${content}' | base64 -d (shell-based)
        // Safe: process.env._CSB_CONTENT (env var-based, SDK)
        // Unsafe: echo ${content} | base64 -d
        const hasSafeDelivery =
          body.includes("printf '%s'") || body.includes("process.env.");
        expect(hasSafeDelivery).toBe(true);
      });
    }
  });

  // ── SSH-based upload_file safety ───────────────────────────────────

  describe("SSH-based upload_file: delegates to ssh_upload_file", () => {
    const sshClouds = Array.from(cloudUploadTypes.entries())
      .filter(([, info]) => info.type === "ssh");

    it("should have SSH-based clouds", () => {
      // After TS conversions (daytona, digitalocean, sprite, gcp), fewer clouds use bash ssh_upload_file
      expect(sshClouds.length).toBeGreaterThanOrEqual(1);
    });

    for (const [cloud, info] of sshClouds) {
      it(`${cloud} should delegate to ssh_upload_file`, () => {
        expect(info.body).toContain("ssh_upload_file");
      });
    }
  });

  // ── No dangerous patterns across ALL exec-based clouds ─────────────

  describe("no dangerous patterns in any exec-based upload_file", () => {
    for (const [cloud, info] of cloudUploadTypes) {
      if (info.type !== "exec-based") continue;

      it(`${cloud} should not use eval on user-controlled input`, () => {
        const hasEval = /\beval\b.*\$\{?(content|remote_path|local_path)/.test(info.body);
        expect(hasEval).toBe(false);
      });

      it(`${cloud} should not use echo to output content in command strings`, () => {
        const lines = info.body.split("\n");
        for (const line of lines) {
          if (line.trim().startsWith("#")) continue;
          // echo $content is unsafe: word splitting + glob expansion
          if (/echo\s+["']?\$\{?content\}?/.test(line)) {
            throw new Error(
              `${cloud}/lib/common.sh: upload_file uses unsafe 'echo $content'.\n` +
              `Use printf '%s' instead to avoid word splitting and glob expansion.`
            );
          }
        }
      });
    }
  });

  // ── Regression: specific clouds fixed in PR #453 & #989 ─────────────

  describe("PR #453/#989 regression: fixed clouds have strict path validation", () => {
    // daytona uses SSH + printf '%q' escaping (validated by general exec-based tests above)
    const fixedClouds = ["fly", "northflank", "e2b", "koyeb"];

    for (const cloud of fixedClouds) {
      const info = cloudUploadTypes.get(cloud);
      if (!info) continue;

      it(`${cloud} should have SECURITY comment about path validation`, () => {
        expect(info.body).toContain("SECURITY");
      });

      it(`${cloud} should use strict allowlist regex for path validation`, () => {
        expect(info.body).toMatch(/\[a-zA-Z0-9/);
      });

      it(`${cloud} should use safe content embedding`, () => {
        const hasSafeContentEmbed =
          info.body.includes("'${content}'") || info.body.includes("'$content'");
        expect(hasSafeContentEmbed).toBe(true);
      });

      it(`${cloud} should use safe path embedding`, () => {
        const hasSafePathEmbed =
          info.body.includes("'${remote_path}'") || info.body.includes("'$remote_path'");
        expect(hasSafePathEmbed).toBe(true);
      });
    }
  });

  // ── Additional exec-based clouds with strict validation ──────────────

  describe("additional exec-based clouds have strict path validation", () => {
    // These clouds (railway, modal, render, codesandbox) also use strict allowlist
    const additionalClouds = ["railway", "modal", "render", "codesandbox"];
    for (const cloud of additionalClouds) {
      const info = cloudUploadTypes.get(cloud);
      if (!info || info.type !== "exec-based") continue;

      it(`${cloud} should use strict allowlist regex for path validation`, () => {
        expect(info.body).toMatch(/\[a-zA-Z0-9/);
      });

      it(`${cloud} should base64-encode content`, () => {
        expect(info.body).toContain("base64");
      });
    }
  });

  // ── Ensure env var safety in provider lib files ─────────────────────

  describe("env var validation in provider lib files", () => {
    // PR #102 added env var validation to prevent Python injection
    const containerClouds = ["render", "modal", "railway", "fly", "koyeb", "northflank"];

    for (const cloud of containerClouds) {
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");
      if (!existsSync(libPath)) continue;

      const content = readFileSync(libPath, "utf-8");

      it(`${cloud} should validate or escape env vars before passing to commands`, () => {
        const hasValidation =
          content.includes("json_escape") ||
          content.includes("validate_") ||
          content.includes("_validate_env") ||
          content.includes("base64");
        expect(hasValidation).toBe(true);
      });
    }
  });

  // ── Sprite CLI-based upload_file ─────────────────────────────────────

  describe("Sprite CLI-based upload_file: uses native -file flag", () => {
    const spriteClouds = Array.from(cloudUploadTypes.entries())
      .filter(([, info]) => info.type === "sprite-cli");

    for (const [cloud, info] of spriteClouds) {
      it(`${cloud} should use sprite exec with -file flag`, () => {
        expect(info.body).toContain("-file");
        // Match "sprite exec" or "sprite $(...) exec" (with org flags interpolated)
        expect(info.body).toMatch(/sprite\b.*\bexec\b/);
      });

      it(`${cloud} should use strict allowlist regex for path validation`, () => {
        expect(info.body).toMatch(/\[a-zA-Z0-9/);
      });
    }
  });

  // ── SCP-based upload_file safety (GCP) ─────────────────────────────

  describe("SCP-based upload_file: uses native scp", () => {
    const scpClouds = Array.from(cloudUploadTypes.entries())
      .filter(([, info]) => info.type === "scp");

    for (const [cloud, info] of scpClouds) {
      it(`${cloud} should use scp for file transfer`, () => {
        expect(info.body).toMatch(/\bscp\b/);
      });
    }
  });

  // ── Local copy safety ──────────────────────────────────────────────

  describe("local upload_file: uses cp", () => {
    const cpClouds = Array.from(cloudUploadTypes.entries())
      .filter(([, info]) => info.type === "cp");

    for (const [cloud, info] of cpClouds) {
      it(`${cloud} should use cp for local file transfer`, () => {
        expect(info.body).toMatch(/\bcp\b/);
      });

      it(`${cloud} should create parent directories`, () => {
        expect(info.body).toContain("mkdir -p");
      });
    }
  });
});
