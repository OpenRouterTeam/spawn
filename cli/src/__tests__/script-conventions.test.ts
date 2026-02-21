import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Manifest } from "../manifest";

/**
 * Shell script convention tests.
 *
 * Validates that ALL implemented scripts follow the conventions from CLAUDE.md:
 * - Shebang line (#!/bin/bash)
 * - set -eo pipefail (or at minimum set -e)
 * - Sources cloud lib/common.sh
 * - No echo -e (macOS bash 3.x incompatible)
 * - No source <(...) process substitution
 * - No set -u / set -o nounset
 * - Cloud lib/common.sh files source shared/common.sh
 * - Remote fallback pattern present for curl|bash compatibility
 *
 * Unlike manifest-integrity.test.ts which samples 20 scripts, these tests
 * check ALL implemented scripts exhaustively.
 *
 * Agent: test-engineer
 */

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const manifestPath = join(REPO_ROOT, "manifest.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifest: Manifest = JSON.parse(manifestRaw);

// Clouds that use TypeScript instead of bash lib/common.sh (thin .sh shims)
const TS_CLOUDS = new Set(["fly"]);

const matrixEntries = Object.entries(manifest.matrix);
const implementedEntries = matrixEntries.filter(([, status]) => status === "implemented");
const implementedScripts = implementedEntries
  .map(([key]) => ({ key, path: join(REPO_ROOT, key + ".sh") }))
  .filter(({ path }) => existsSync(path));

// Collect unique clouds with implementations
const cloudsWithImpls = new Set<string>();
for (const [key, status] of matrixEntries) {
  if (status === "implemented") {
    cloudsWithImpls.add(key.split("/")[0]);
  }
}

/** Read file content, stripping comment-only lines for pattern checks */
function readScript(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

/** Get non-comment lines from a script */
function getNonCommentLines(content: string): string[] {
  return content.split("\n").filter((line) => !line.trimStart().startsWith("#"));
}

describe("Shell Script Convention Compliance", () => {
  // ── Shebang ─────────────────────────────────────────────────────────

  describe("shebang (#!/bin/bash)", () => {
    it("should have a bash shebang on every implemented script", () => {
      const failures: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        if (!content.trimStart().startsWith("#!/bin/bash")) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts missing #!/bin/bash shebang:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── set -e / set -eo pipefail ───────────────────────────────────────

  describe("error handling (set -e)", () => {
    it("should use set -e or set -eo pipefail on every implemented script", () => {
      const failures: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        const hasSetE = content.includes("set -e") || content.includes("set -eo pipefail");
        if (!hasSetE) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts missing set -e / set -eo pipefail:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });

    it("should prefer set -eo pipefail over bare set -e", () => {
      const bareSetE: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        if (content.includes("set -e") && !content.includes("set -eo pipefail")) {
          bareSetE.push(key + ".sh");
        }
      }

      // This is a soft check: warn but don't fail
      // Some scripts may have valid reasons for bare set -e
      if (bareSetE.length > 0) {
        console.log(
          `Note: ${bareSetE.length} scripts use bare "set -e" instead of "set -eo pipefail": ${bareSetE.join(", ")}`
        );
      }
      // Just ensure the count is below a reasonable threshold
      expect(bareSetE.length).toBeLessThan(implementedScripts.length / 2);
    });
  });

  // ── Sources cloud lib/common.sh ─────────────────────────────────────

  describe("sources cloud lib/common.sh", () => {
    it("should reference lib/common.sh in every implemented script", () => {
      const failures: string[] = [];

      for (const { key, path } of implementedScripts) {
        const cloud = key.split("/")[0];
        // TS-based clouds use thin .sh shims that don't source lib/common.sh
        if (TS_CLOUDS.has(cloud)) continue;
        const content = readScript(path);
        if (!content.includes("lib/common.sh") && !content.includes(`${cloud}/lib/common.sh`)) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts do not source lib/common.sh:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── macOS bash 3.x compatibility ────────────────────────────────────

  describe("macOS bash 3.x compatibility", () => {
    it("should not use echo -e in any implemented script", () => {
      const violations: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        const lines = getNonCommentLines(content);
        for (const line of lines) {
          if (/\becho\s+-e\b/.test(line)) {
            violations.push(key + ".sh");
            break;
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} scripts use echo -e (use printf instead for macOS compat):\n` +
            violations.map((f) => `  - ${f}`).join("\n")
        );
      }
    });

    it("should not use source <(...) process substitution in any implemented script", () => {
      const violations: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        const lines = getNonCommentLines(content);
        for (const line of lines) {
          if (/source\s+<\(/.test(line)) {
            violations.push(key + ".sh");
            break;
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} scripts use source <(...) (use eval "$(cmd)" instead):\n` +
            violations.map((f) => `  - ${f}`).join("\n")
        );
      }
    });

    it("should not use set -u or set -o nounset in any implemented script", () => {
      const violations: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        const lines = getNonCommentLines(content);
        for (const line of lines) {
          if (/\bset\s+.*-.*u\b/.test(line) && !line.includes("pipefail")) {
            violations.push(key + ".sh");
            break;
          }
          if (/set\s+-o\s+nounset/.test(line)) {
            violations.push(key + ".sh");
            break;
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} scripts use set -u / nounset (use \${VAR:-} instead):\n` +
            violations.map((f) => `  - ${f}`).join("\n")
        );
      }
    });
  });

  // ── Cloud lib/common.sh sources shared/common.sh ────────────────────

  describe("cloud lib/common.sh files source shared/common.sh", () => {
    for (const cloud of cloudsWithImpls) {
      // TS-based clouds don't use bash lib/common.sh
      if (TS_CLOUDS.has(cloud)) continue;
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");

      it(`${cloud}/lib/common.sh should reference shared/common.sh`, () => {
        if (!existsSync(libPath)) {
          throw new Error(`${cloud}/lib/common.sh does not exist`);
        }
        const content = readScript(libPath);
        expect(
          content.includes("shared/common.sh")
        ).toBe(true);
      });
    }
  });

  // ── Remote fallback pattern ─────────────────────────────────────────

  describe("remote fallback pattern for curl|bash compatibility", () => {
    it("should have SCRIPT_DIR or remote fallback in every implemented script", () => {
      const failures: string[] = [];

      for (const { key, path } of implementedScripts) {
        const content = readScript(path);
        // Scripts should use SCRIPT_DIR for local resolution or eval+curl for remote
        const hasScriptDir = content.includes("SCRIPT_DIR");
        const hasEvalCurl = content.includes("eval") && content.includes("curl");
        if (!hasScriptDir && !hasEvalCurl) {
          failures.push(key + ".sh");
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `${failures.length} scripts missing SCRIPT_DIR or eval+curl remote fallback:\n` +
            failures.map((f) => `  - ${f}`).join("\n")
        );
      }
    });

    for (const cloud of cloudsWithImpls) {
      // TS-based clouds don't use bash lib/common.sh
      if (TS_CLOUDS.has(cloud)) continue;
      const libPath = join(REPO_ROOT, cloud, "lib", "common.sh");

      it(`${cloud}/lib/common.sh should have remote fallback for shared/common.sh`, () => {
        if (!existsSync(libPath)) {
          throw new Error(`${cloud}/lib/common.sh does not exist`);
        }
        const content = readScript(libPath);
        // Should have both SCRIPT_DIR and a curl fallback
        expect(content.includes("SCRIPT_DIR")).toBe(true);
        // Should have curl fallback to raw.githubusercontent.com
        const hasCurlFallback =
          content.includes("raw.githubusercontent.com") || content.includes("curl");
        expect(hasCurlFallback).toBe(true);
      });
    }
  });

  // ── Coverage stats ──────────────────────────────────────────────────

  describe("coverage stats", () => {
    it("should check a significant number of scripts", () => {
      // Ensure we're testing all implemented scripts, not just a sample
      expect(implementedScripts.length).toBeGreaterThan(40);
    });

    it("should check all clouds with implementations", () => {
      expect(cloudsWithImpls.size).toBeGreaterThanOrEqual(8);
    });
  });
});
