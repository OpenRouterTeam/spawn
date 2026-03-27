// shared/spawn-skill.ts — Skill injection for recursive spawn
// Writes agent-native instruction files teaching each agent how to use `spawn`.
// Content is embedded directly so it works when installed via npm (no fs reads).

import type { CloudRunner } from "./agent-setup.js";

import { wrapSshCall } from "./agent-setup.js";
import { asyncTryCatchIf, isOperationalError } from "./result.js";
import { logInfo, logWarn } from "./ui.js";

// ─── Embedded skill content ─────────────────────────────────────────────────

/** YAML frontmatter skill (Claude Code, Codex CLI, OpenClaw). */
const SKILL_FRONTMATTER = `---
name: spawn
description: Create child cloud VMs with AI coding agents using the spawn CLI
allowed-tools: Bash
---

`;

/** Main skill body (shared by all agents except hermes). */
const SKILL_BODY = `# Spawn — Create Child VMs

You have the \`spawn\` CLI installed. Use it to provision cloud VMs with AI agents.

## Usage

\`\`\`bash
spawn <agent> <cloud> --headless --output json --prompt "task description"
\`\`\`

## Agents: claude, cursor, codex, openclaw, zeroclaw, opencode, kilocode, hermes, junie
## Clouds: hetzner, digitalocean, aws, gcp, sprite

## Example

\`\`\`bash
spawn claude hetzner --headless --output json --prompt "Implement the auth module"
\`\`\`

Returns JSON: \`{"status":"success","ip_address":"...","ssh_user":"root","server_id":"..."}\`

## Running a prompt on a child VM

**--headless only provisions the VM — it does NOT run the prompt on it.**
To actually execute work on the child, SSH in and run the agent:

\`\`\`bash
ssh -o StrictHostKeyChecking=accept-new root@<ip_address> '~/.local/bin/claude --print "your prompt"'
\`\`\`

### Known gotchas — do NOT waste time rediscovering these:
- Agent binaries are at \`~/.local/bin/\`, NOT on the default PATH. Always use the full path: \`~/.local/bin/claude\`, \`~/.local/bin/cursor\`, etc.
- Claude Code blocks \`--dangerously-skip-permissions\` as root. Use \`--print\` for one-shot prompts instead — it works as root and returns the response directly.
- Do NOT try to create a non-root user to work around root restrictions — it requires copying config files (\`.claude.json\`, \`.claude/settings.json\`, env vars) and is fragile. Just use \`--print\`.
- For long-running tasks, use \`spawn delete --name <name> --yes\` to clean up when done.

## Managing Children

- \`spawn list --json\` — see running children
- \`spawn delete --name <name> --yes\` — tear down a child VM (headless)
- \`spawn tree\` — see the full spawn tree

## Context

- You are running inside a spawned VM (SPAWN_DEPTH is set)
- Cloud credentials are pre-configured — no auth prompts
- OpenRouter billing is shared with the parent
`;

/** Short snippet for Hermes (appended to SOUL.md, 20K char cap). */
const HERMES_SNIPPET = `

## Spawn Capability

You have the \`spawn\` CLI for creating child cloud VMs with AI agents.
Use \`spawn <agent> <cloud> --headless --output json --prompt "task"\` to delegate work.
Available agents: claude, cursor, codex, openclaw, zeroclaw, opencode, kilocode, hermes, junie.
Cloud credentials are pre-configured. Run \`spawn list --json\` to see children.
Note: --headless only provisions the VM. To run a prompt, SSH in: \`ssh root@<ip> '~/.local/bin/<agent> --print "prompt"'\`.
`;

// ─── Agent config ───────────────────────────────────────────────────────────

interface SkillConfig {
  remotePath: string;
  content: string;
  append: boolean;
}

/** Per-agent skill configuration: remote path, content, and write mode. */
const AGENT_SKILLS: Record<string, SkillConfig> = {
  claude: {
    remotePath: "~/.claude/skills/spawn/SKILL.md",
    content: SKILL_FRONTMATTER + SKILL_BODY,
    append: false,
  },
  codex: {
    remotePath: "~/.agents/skills/spawn/SKILL.md",
    content: SKILL_FRONTMATTER + SKILL_BODY,
    append: false,
  },
  openclaw: {
    remotePath: "~/.openclaw/skills/spawn/SKILL.md",
    content: SKILL_FRONTMATTER + SKILL_BODY,
    append: false,
  },
  zeroclaw: {
    remotePath: "~/.zeroclaw/workspace/AGENTS.md",
    content: SKILL_BODY,
    append: false,
  },
  opencode: {
    remotePath: "~/.config/opencode/AGENTS.md",
    content: SKILL_BODY,
    append: false,
  },
  kilocode: {
    remotePath: "~/.kilocode/rules/spawn.md",
    content: SKILL_BODY,
    append: false,
  },
  hermes: {
    remotePath: "~/.hermes/SOUL.md",
    content: HERMES_SNIPPET,
    append: true,
  },
  junie: {
    remotePath: "~/.junie/AGENTS.md",
    content: SKILL_BODY,
    append: false,
  },
};

/** Get the remote target path for a given agent's spawn skill file. */
export function getSpawnSkillPath(agentName: string): string | undefined {
  return AGENT_SKILLS[agentName]?.remotePath;
}

/** Whether the agent uses append mode (hermes appends to SOUL.md). */
export function isAppendMode(agentName: string): boolean {
  return AGENT_SKILLS[agentName]?.append === true;
}

/** Get the embedded skill content for an agent. */
export function getSkillContent(agentName: string): string | undefined {
  return AGENT_SKILLS[agentName]?.content;
}

/**
 * Inject the spawn skill file onto a remote VM for the given agent.
 * Base64-encodes embedded content and writes to the agent's native
 * instruction file path on the remote.
 */
export async function injectSpawnSkill(runner: CloudRunner, agentName: string): Promise<void> {
  const config = AGENT_SKILLS[agentName];
  if (!config) {
    logWarn(`No spawn skill file for agent: ${agentName}`);
    return;
  }

  const b64 = Buffer.from(config.content).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
    throw new Error("Unexpected characters in base64 output");
  }

  const { remotePath, append } = config;
  const operator = append ? ">>" : ">";
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
