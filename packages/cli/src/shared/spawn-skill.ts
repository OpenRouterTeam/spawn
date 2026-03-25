// shared/spawn-skill.ts — Skill injection for recursive spawn
// Writes agent-native instruction files teaching each agent how to use `spawn`.

import type { CloudRunner } from "./agent-setup.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wrapSshCall } from "./agent-setup.js";
import { asyncTryCatchIf, isOperationalError, tryCatch } from "./result.js";
import { logInfo, logWarn } from "./ui.js";

/** Map agent name → remote path where the skill file should be written. */
const SKILL_REMOTE_PATHS: Record<string, string> = {
  claude: "~/.claude/skills/spawn/SKILL.md",
  codex: "~/.agents/skills/spawn/SKILL.md",
  openclaw: "~/.openclaw/skills/spawn/SKILL.md",
  zeroclaw: "~/.zeroclaw/workspace/AGENTS.md",
  opencode: "~/.config/opencode/AGENTS.md",
  kilocode: "~/.kilocode/rules/spawn.md",
  hermes: "~/.hermes/SOUL.md",
  junie: "~/.junie/AGENTS.md",
};

/** Map agent name → local file inside the skills/ directory. */
const SKILL_SOURCE_FILES: Record<string, string> = {
  claude: "claude/SKILL.md",
  codex: "codex/SKILL.md",
  openclaw: "openclaw/SKILL.md",
  zeroclaw: "zeroclaw/AGENTS.md",
  opencode: "opencode/AGENTS.md",
  kilocode: "kilocode/spawn.md",
  hermes: "hermes/SOUL.md",
  junie: "junie/AGENTS.md",
};

/** Agents that use append mode (>>) instead of overwrite (>). */
const APPEND_AGENTS = new Set([
  "hermes",
]);

/** Get the remote target path for a given agent's spawn skill file. */
export function getSpawnSkillPath(agentName: string): string | undefined {
  return SKILL_REMOTE_PATHS[agentName];
}

/** Get the local source file path (relative to skills/) for a given agent. */
export function getSpawnSkillSourceFile(agentName: string): string | undefined {
  return SKILL_SOURCE_FILES[agentName];
}

/** Whether the agent uses append mode (hermes appends to SOUL.md). */
export function isAppendMode(agentName: string): boolean {
  return APPEND_AGENTS.has(agentName);
}

/**
 * Resolve the absolute path to the skills/ directory.
 * Works both in dev (source tree) and when bundled (cli.js next to skills/).
 */
function getSkillsDir(): string {
  // In the source tree: packages/cli/src/shared/spawn-skill.ts
  // skills/ is at the repo root: ../../../../skills/
  // When bundled as cli.js: packages/cli/cli.js → ../../skills/
  // Use import.meta.dir which gives the directory of the current file.
  const candidates = [
    join(import.meta.dir, "../../../../skills"),
    join(import.meta.dir, "../../../skills"),
    join(import.meta.dir, "../../skills"),
  ];
  for (const candidate of candidates) {
    const r = tryCatch(() => readFileSync(join(candidate, "claude/SKILL.md")));
    if (r.ok) {
      return candidate;
    }
  }
  // Fallback: assume repo root relative to process.cwd()
  return join(process.cwd(), "skills");
}

/**
 * Read a skill file's content from the local skills/ directory.
 * Returns null if the file doesn't exist or the agent has no skill file.
 */
export function readSkillContent(agentName: string): string | null {
  const sourceFile = getSpawnSkillSourceFile(agentName);
  if (!sourceFile) {
    return null;
  }
  const r = tryCatch(() => readFileSync(join(getSkillsDir(), sourceFile), "utf-8"));
  return r.ok ? r.data : null;
}

/**
 * Inject the spawn skill file onto a remote VM for the given agent.
 * Reads content from skills/{agent}/, base64-encodes it, and writes
 * to the agent's native instruction file path on the remote.
 */
export async function injectSpawnSkill(runner: CloudRunner, agentName: string): Promise<void> {
  const remotePath = getSpawnSkillPath(agentName);
  const content = readSkillContent(agentName);

  if (!remotePath || !content) {
    logWarn(`No spawn skill file for agent: ${agentName}`);
    return;
  }

  const b64 = Buffer.from(content).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
    throw new Error("Unexpected characters in base64 output");
  }

  const append = isAppendMode(agentName);
  const operator = append ? ">>" : ">";
  // dirname of ~ paths like ~/.claude/skills/spawn/SKILL.md
  // We need to extract the directory portion for mkdir -p
  const remoteDir = remotePath.slice(0, remotePath.lastIndexOf("/"));

  const cmd = append
    ? `mkdir -p ${remoteDir} && printf '%s' '${b64}' | base64 -d ${operator} ${remotePath}`
    : `mkdir -p ${remoteDir} && printf '%s' '${b64}' | base64 -d ${operator} ${remotePath} && chmod 644 ${remotePath}`;

  const result = await asyncTryCatchIf(isOperationalError, () => wrapSshCall(runner.runServer(cmd)));

  if (result.ok) {
    logInfo(`Spawn skill injected: ${remotePath}`);
  } else {
    logWarn("Spawn skill injection failed — agent will work without spawn instructions");
  }
}
