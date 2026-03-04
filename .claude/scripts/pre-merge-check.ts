/**
 * PreToolUse hook for Bash — runs biome check + bun test before `gh pr merge` or `gh pr ready`.
 *
 * Reads hook JSON from stdin, extracts tool_input.command.
 * If the command contains `gh pr merge` or `gh pr ready`, runs the full pre-merge gate.
 * Blocks (exit 2) if biome check or bun test fails.
 */

import { execFileSync } from "child_process";

const raw = await Bun.stdin.text();
let command: string | undefined;

try {
  const input: unknown = JSON.parse(raw);
  if (
    input !== null &&
    typeof input === "object" &&
    "tool_input" in input &&
    input.tool_input !== null &&
    typeof input.tool_input === "object" &&
    "command" in input.tool_input &&
    typeof input.tool_input.command === "string"
  ) {
    command = input.tool_input.command;
  }
} catch {
  // Malformed JSON — let it pass
}

if (!command) process.exit(0);

// Only intercept gh pr merge / gh pr ready
if (!command.includes("gh pr merge") && !command.includes("gh pr ready")) {
  process.exit(0);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// Find repo root — try extracting a worktree path from the command, else use git
let repoRoot: string;
const worktreeMatch = command.match(/\/tmp\/spawn-worktrees\/[^\s/]+/);
if (worktreeMatch) {
  repoRoot = worktreeMatch[0];
} else {
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    // Not in a git repo — let it pass
    process.exit(0);
  }
}

const cliDir = `${repoRoot}/packages/cli`;

// Run biome check
console.error(`Pre-merge gate: running biome check in ${cliDir}...`);
try {
  execFileSync("bunx", ["@biomejs/biome", "check", "src/"], {
    cwd: cliDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 120_000,
  });
} catch {
  fail(`BLOCKED: biome check failed in ${cliDir}. Fix lint/format errors before merging.`);
}

// Run bun test
console.error(`Pre-merge gate: running bun test in ${cliDir}...`);
try {
  execFileSync("bun", ["test"], {
    cwd: cliDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 120_000,
  });
} catch {
  fail(`BLOCKED: bun test failed in ${cliDir}. Fix failing tests before merging.`);
}

console.error("Pre-merge gate: all checks passed.");
