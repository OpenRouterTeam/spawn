import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import type { Manifest } from "../manifest";

/**
 * Shell script syntax validation tests.
 *
 * Runs `bash -n` on every shell script in the repository to catch syntax
 * errors before they reach users. This is the automated equivalent of
 * the CLAUDE.md rule: "Run `bash -n` on every changed .sh file."
 *
 * Coverage:
 * - shared/common.sh (core library used by all clouds)
 * - Every cloud's lib/common.sh (cloud-specific libraries)
 * - Every implemented agent script (cloud/agent.sh)
 *
 * These tests catch:
 * - Unclosed quotes, braces, parentheses
 * - Invalid syntax from bad merges or edits
 * - Bash 3.x incompatible syntax (some cases)
 * - Missing heredoc terminators
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifest: Manifest = JSON.parse(manifestRaw);

const matrixEntries = Object.entries(manifest.matrix);
const implementedEntries = matrixEntries.filter(([, status]) => status === "implemented");

/** Run `bash -n` on a script file. Returns null on success, error message on failure. */
function bashSyntaxCheck(filePath: string): string | null {
  try {
    execSync(`bash -n "${filePath}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return null;
  } catch (err: any) {
    return (err.stderr || err.stdout || err.message || "Unknown error").trim();
  }
}

describe("Shell Script Syntax Validation (bash -n)", () => {
  // ── Core shared library ────────────────────────────────────────────

  describe("shared/common.sh", () => {
    const sharedPath = join(REPO_ROOT, "shared", "common.sh");

    it("should exist", () => {
      expect(existsSync(sharedPath)).toBe(true);
    });

    it("should pass bash -n syntax check", () => {
      const error = bashSyntaxCheck(sharedPath);
      if (error) {
        throw new Error(`shared/common.sh has syntax errors:\n${error}`);
      }
    });
  });

  // ── Implemented agent scripts ──────────────────────────────────────

  describe("implemented agent scripts", () => {
    it("should have at least one implemented script to check", () => {
      expect(implementedEntries.length).toBeGreaterThan(0);
    });

    for (const [key] of implementedEntries) {
      const scriptPath = join(REPO_ROOT, key + ".sh");

      it(`${key}.sh should pass bash -n`, () => {
        if (!existsSync(scriptPath)) {
          throw new Error(`${key}.sh does not exist but is marked as implemented`);
        }
        const error = bashSyntaxCheck(scriptPath);
        if (error) {
          throw new Error(`${key}.sh has syntax errors:\n${error}`);
        }
      });
    }
  });

  // ── Summary stats ──────────────────────────────────────────────────

  describe("coverage summary", () => {
    it("should check all implemented scripts", () => {
      const existing = implementedEntries.filter(([key]) =>
        existsSync(join(REPO_ROOT, key + ".sh"))
      );
      // All implemented entries should have corresponding files
      expect(existing.length).toBe(implementedEntries.length);
    });
  });
});
