/**
 * PostToolUse hook for Write|Edit — validates shell and TypeScript files after modification.
 *
 * Reads CLAUDE_FILE env var. Performs:
 * - .sh files: bash -n syntax check, relative source detection, echo -e, set -u
 * - .ts files: banner comment detection, biome lint + format
 *
 * Blocks (exit 2) on any failure.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const file = process.env.CLAUDE_FILE;
if (!file) {
  process.exit(0);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function run(
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
  },
): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    cwd: opts?.cwd,
    timeout: 60_000,
  });
}

// --- Shell file checks ---
if (file.endsWith(".sh")) {
  // bash -n syntax check
  try {
    run("bash", [
      "-n",
      file,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`SYNTAX ERROR in ${file}\n${msg}`);
  }

  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    process.exit(0);
  }

  // Check for relative source patterns
  if (/source\s+\.\.?\//.test(content)) {
    fail(`RELATIVE SOURCE detected in ${file} — breaks curl|bash execution`);
  }

  // Check for echo -e (macOS bash 3.x compat)
  if (/echo\s+-e\s/.test(content)) {
    fail(`echo -e detected in ${file} — use printf instead (macOS bash 3.x compat)`);
  }

  // Check for set -u without set -eo pipefail
  if (/set\s+-.*u/.test(content) && !/set\s+-eo\s+pipefail/.test(content)) {
    fail(`set -u (nounset) detected in ${file} — use set -eo pipefail instead`);
  }
}

// --- TypeScript file checks ---
if (file.endsWith(".ts")) {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    process.exit(0);
  }

  // Check for banner comments (lines of 10+ dashes, equals, asterisks, or hashes)
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\/\/\s*[-=*#]{10,}\s*$/.test(lines[i])) {
      fail(`BANNER COMMENT at ${file}:${i + 1} — use // #region Name / // #endregion instead`);
    }
  }

  // Find biome config by walking up from the file's directory to the repo root
  let biomeDir: string | null = null;
  let searchDir = dirname(file);
  const root = resolve("/");
  while (searchDir !== root) {
    if (existsSync(resolve(searchDir, "biome.json")) || existsSync(resolve(searchDir, "biome.jsonc"))) {
      biomeDir = searchDir;
      break;
    }
    searchDir = resolve(searchDir, "..");
  }

  if (biomeDir) {
    // Run biome check (lint + format) in a single pass
    try {
      run(
        "bunx",
        [
          "@biomejs/biome",
          "check",
          file,
        ],
        {
          cwd: biomeDir,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(`BIOME CHECK FAILED for ${file}\n${msg}`);
    }
  }
}
