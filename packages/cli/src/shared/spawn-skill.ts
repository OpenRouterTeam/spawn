// shared/spawn-skill.ts — Skill injection for recursive spawn
// Writes agent-native instruction files teaching each agent how to use `spawn`.
// Content is embedded directly so it works when installed via npm (no fs reads).

import type { CloudRunner } from "./agent-setup.js";

import { validateScriptTemplate, wrapSshCall } from "./agent-setup.js";
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

## Provision a Child VM

\`\`\`bash
spawn <agent> <cloud> --headless --output json --prompt "task description"
\`\`\`

**Agents:** claude, codex, cursor, openclaw, opencode, kilocode, hermes, junie, pi
**Clouds:** hetzner, digitalocean, aws, gcp, daytona, sprite

Returns JSON: \`{"status":"success","ip_address":"...","ssh_user":"root","server_id":"..."}\`

## Running Prompts on Child VMs

\`--headless\` only provisions — to run work on the child, SSH in with \`bash -lc\`:

\`\`\`bash
# Claude Code (use -p, NOT --print or --headless)
ssh -o StrictHostKeyChecking=accept-new root@<ip> "bash -lc 'claude -p --dangerously-skip-permissions \\"your prompt\\"'"

# Codex CLI
ssh -o StrictHostKeyChecking=accept-new root@<ip> "bash -lc 'codex --quiet \\"your prompt\\"'"
\`\`\`

### IMPORTANT — do NOT waste tokens rediscovering these:
- **Always use \`bash -lc\`** — agent binaries are in \`~/.local/bin/\` which is only on PATH in login shells
- **Claude uses \`-p\`** for non-interactive output (NOT \`--print\`, NOT \`--headless\`)
- **Add \`--dangerously-skip-permissions\`** to skip approval prompts on child VMs
- **Never try \`which claude\` or \`find\`** to locate binaries — they are always at \`~/.local/bin/<agent>\`
- **Never create non-root users** to work around permission issues — just use \`-p\`

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
Available agents: claude, codex, cursor, openclaw, opencode, kilocode, hermes, junie, pi.
Cloud credentials are pre-configured. Run \`spawn list --json\` to see children.
\`--headless\` only provisions. To run a prompt on the child: \`ssh root@<ip> "bash -lc 'claude -p --dangerously-skip-permissions \\"prompt\\"'"\`. Always use \`bash -lc\` (binaries are in ~/.local/bin/).
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
  cursor: {
    remotePath: "~/.cursor/rules/spawn.md",
    content: SKILL_BODY,
    append: false,
  },
  junie: {
    remotePath: "~/.junie/AGENTS.md",
    content: SKILL_BODY,
    append: false,
  },
  pi: {
    remotePath: "~/.pi/agent/skills/spawn/SKILL.md",
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

  validateScriptTemplate(config.content, `spawn-skill-${agentName}`);

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
