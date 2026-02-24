/**
 * Lint rule: no decorative banner comments.
 *
 * Catches patterns like:
 *   // ---------------------------------------------------------------------------
 *   // Section Name
 *   // ---------------------------------------------------------------------------
 *
 * Suggests instead:
 *   // #region Section Name ... // #endregion
 *   /** Section Name *​/
 *
 * Usage: bun run lint/no-banner-comments.ts [files...]
 * If no files given, checks all .ts files under cli/src/ and .claude/skills/.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

const SEPARATOR_RE = /^\/\/\s*[-=*#]{10,}\s*$/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function check(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (SEPARATOR_RE.test(trimmed)) {
      violations.push({
        file: filePath,
        line: i + 1,
        text: trimmed,
      });
    }
  }

  return violations;
}

// Collect files
let files = process.argv.slice(2);

if (files.length === 0) {
  const patterns = ["cli/src/**/*.ts", ".claude/skills/**/*.ts"];
  const cwd = resolve(import.meta.dirname, "..");
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for (const match of glob.scanSync({
      cwd,
      absolute: true,
    })) {
      files.push(match);
    }
  }
}

let total = 0;
for (const file of files) {
  const violations = check(file);
  for (const v of violations) {
    console.error(`${v.file}:${v.line} — banner comment: ${v.text}`);
    console.error("  Use `// #region Name` / `// #endregion` or `/** Name */` instead.\n");
  }
  total += violations.length;
}

if (total > 0) {
  console.error(`Found ${total} banner comment(s). Use region comments or /** */ section headers instead.`);
  process.exit(1);
}
