/**
 * PreToolUse hook for Write|Edit — ensures edits happen in a git worktree on a feature branch.
 *
 * Reads hook JSON from stdin, extracts tool_input.file_path.
 * Blocks (exit 2) if the file is in the main checkout or on the main branch.
 */

import { execFileSync } from "child_process";
import { dirname } from "path";
import { existsSync } from "fs";
import { FilePathInput, parseStdin } from "./schemas.ts";

const raw = await Bun.stdin.text();
const parsed = parseStdin(raw, FilePathInput);
if (!parsed) process.exit(0);

const filePath = parsed.tool_input.file_path;

const dir = dirname(filePath);
if (!existsSync(dir)) process.exit(0);

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

let gitDir: string;
let gitCommonDir: string;
try {
  gitDir = git("rev-parse", "--git-dir");
  gitCommonDir = git("rev-parse", "--git-common-dir");
} catch {
  // Not a git repo — let it pass
  process.exit(0);
}

// Resolve to absolute paths
const resolveFromDir = (p: string) => {
  if (p.startsWith("/")) return p;
  return execFileSync("realpath", ["-m", `${dir}/${p}`], { encoding: "utf-8" }).trim();
};

const absGitDir = resolveFromDir(gitDir);
const absCommonDir = resolveFromDir(gitCommonDir);

if (absGitDir === absCommonDir) {
  console.error("BLOCKED: Edits must happen in a git worktree, not the main checkout.");
  console.error("Create a worktree first: git worktree add /tmp/spawn-worktrees/FEATURE -b branch-name");
  console.error("Then use absolute paths under /tmp/spawn-worktrees/FEATURE/ for all edits.");
  process.exit(2);
}

let branch: string;
try {
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  process.exit(0);
}

if (branch === "main") {
  console.error("BLOCKED: Cannot edit on main branch, even in a worktree.");
  console.error("Create a worktree with a feature branch: git worktree add /tmp/spawn-worktrees/FEATURE -b branch-name");
  process.exit(2);
}
