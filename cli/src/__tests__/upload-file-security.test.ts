import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Security regression tests for upload_file() functions across all cloud libs.
 *
 * PR #453 fixed command injection vulnerabilities in upload_file() for 5 clouds
 * (fly, northflank, daytona, e2b, koyeb) by replacing unsafe printf '%q'
 * patterns with validated single-quoted embedding.
 *
 * These tests ensure:
 * 1. Non-SSH upload_file functions validate remote_path for injection chars
 *    OR use printf '%q' escaping for safe embedding
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
  if (body.includes("-file") && body.includes("sprite exec")) return "sprite-cli";
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

    it("should have at least 5 exec-based upload_file implementations to test", () => {
      expect(execBasedClouds.length).toBeGreaterThanOrEqual(5);
    });

    it("should check at least 15 clouds total", () => {
      expect(cloudUploadTypes.size).toBeGreaterThanOrEqual(15);
    });
  });

  // ── Remote path injection protection ───────────────────────────────
  // Exec-based clouds must protect against remote_path injection via EITHER:
  //   (a) Character validation: reject ', $, `, newlines in remote_path
  //   (b) printf '%q' escaping: shell-escape the path before embedding

  describe("exec-based upload_file: remote path injection protection", () => {
    for (const { cloud, body } of execBasedClouds) {
      it(`${cloud} should protect remote_path against injection`, () => {
        const hasCharValidation =
          (body.includes(`"'"`) || body.includes("'\\''")) &&
          (body.includes("'$'") || body.includes("\\$"));
        const hasPrintfEscape = body.includes("printf '%q'");
        // Must use at least one protection method
        expect(
          hasCharValidation || hasPrintfEscape
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
      it(`${cloud} should use base64 decode in the remote command`, () => {
        const hasSafeDecode =
          body.includes("base64 -d") || body.includes("base64 --decode");
        expect(hasSafeDecode).toBe(true);
      });

      it(`${cloud} should use printf '%s' for safe content output`, () => {
        // Safe: printf '%s' '${content}' | base64 -d
        // Unsafe: echo ${content} | base64 -d
        expect(body).toContain("printf '%s'");
      });
    }
  });

  // ── SSH-based upload_file safety ───────────────────────────────────

  describe("SSH-based upload_file: delegates to ssh_upload_file", () => {
    const sshClouds = Array.from(cloudUploadTypes.entries())
      .filter(([, info]) => info.type === "ssh");

    it("should have multiple SSH-based clouds", () => {
      expect(sshClouds.length).toBeGreaterThan(5);
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

  // ── Regression: specific clouds fixed in PR #453 ───────────────────

  describe("PR #453 regression: fixed clouds have path validation", () => {
    const fixedClouds = ["fly", "northflank", "daytona", "e2b", "koyeb"];

    for (const cloud of fixedClouds) {
      const info = cloudUploadTypes.get(cloud);
      if (!info) continue;

      it(`${cloud} should have SECURITY comment about path validation`, () => {
        expect(info.body).toContain("SECURITY");
      });

      it(`${cloud} should validate against single-quote breakout`, () => {
        // These specific clouds use the char-validation pattern, not printf '%q'
        expect(info.body).toContain(`"'"`);
      });

      it(`${cloud} should use safe content embedding`, () => {
        const hasSafeContentEmbed =
          info.body.includes("'${content}'") || info.body.includes("'$content'");
        expect(hasSafeContentEmbed).toBe(true);
      });

      it(`${cloud} should use safe path embedding`, () => {
        const hasSafePathEmbed =
          info.body.includes("'${remote_path}'") || info.body.includes("'$remote_path'") ||
          info.body.includes("escaped_path");
        expect(hasSafePathEmbed).toBe(true);
      });
    }
  });

  // ── Printf '%q' pattern clouds: railway, modal ─────────────────────

  describe("printf '%q' pattern clouds have proper escaping", () => {
    // These clouds use printf '%q' to escape paths (not char-by-char validation)
    const printfClouds = execBasedClouds.filter(({ body }) =>
      body.includes("printf '%q'") && !body.includes(`"'"`)
    );

    for (const { cloud, body } of printfClouds) {
      it(`${cloud} should use printf '%q' to escape remote_path`, () => {
        expect(body).toContain("printf '%q'");
        // Escaped variable can be named escaped_path, escaped_remote, etc.
        expect(body).toMatch(/escaped_\w+/);
      });

      it(`${cloud} should base64-encode content before embedding`, () => {
        expect(body).toContain("base64");
        expect(body).toContain("'${content}'");
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
        expect(info.body).toContain("sprite exec");
      });

      it(`${cloud} should escape paths with printf '%q'`, () => {
        expect(info.body).toContain("printf '%q'");
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
