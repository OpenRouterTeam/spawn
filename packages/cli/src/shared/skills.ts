// shared/skills.ts — Skill installation for --beta skills
// Pre-installs MCP servers, instruction skills, and agent configs on remote VMs.

import type { Manifest, McpServerConfig } from "../manifest.js";
import type { CloudRunner } from "./agent-setup.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { toRecord } from "@openrouter/spawn-shared";
import { uploadConfigFile } from "./agent-setup.js";
import { parseJsonObj } from "./parse.js";
import { getTmpDir } from "./paths.js";
import { asyncTryCatch, tryCatch } from "./result.js";
import { validateRemotePath } from "./ssh.js";
import { logInfo, logStep, logWarn, shellQuote } from "./ui.js";

// ─── Skill Filtering ───────────────────────────────────────────────────────────

interface AvailableSkill {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  envVars: string[];
}

/** Get skills available for a given agent from the manifest. */
export function getAvailableSkills(manifest: Manifest, agentName: string): AvailableSkill[] {
  if (!manifest.skills) {
    return [];
  }

  const skills: AvailableSkill[] = [];
  for (const [id, def] of Object.entries(manifest.skills)) {
    const agentConfig = def.agents[agentName];
    if (!agentConfig) {
      continue;
    }
    skills.push({
      id,
      name: def.name,
      description: def.description,
      isDefault: agentConfig.default,
      envVars: def.env_vars ?? [],
    });
  }
  return skills;
}

// ─── Skill Picker ───────────────────────────────────────────────────────────────

/** Show a multiselect prompt for skills. Returns skill IDs or undefined if none available. */
export async function promptSkillSelection(manifest: Manifest, agentName: string): Promise<string[] | undefined> {
  const skills = getAvailableSkills(manifest, agentName);
  if (skills.length === 0) {
    return undefined;
  }

  const defaultIds = skills.filter((s) => s.isDefault).map((s) => s.id);

  const selected = await p.multiselect({
    message: "Skills (↑/↓ navigate, space=toggle, enter=confirm)",
    options: skills.map((s) => {
      const envHint = s.envVars.length > 0 ? ` (needs ${s.envVars.join(", ")})` : "";
      return {
        value: s.id,
        label: s.name,
        hint: s.description + envHint,
      };
    }),
    initialValues: defaultIds.length > 0 ? defaultIds : undefined,
    required: false,
  });

  if (p.isCancel(selected)) {
    return [];
  }

  return selected;
}

// ─── Env Var Collection ─────────────────────────────────────────────────────────

/** Prompt for missing env vars required by selected skills. Returns env pairs for .spawnrc. */
export async function collectSkillEnvVars(manifest: Manifest, selectedSkills: string[]): Promise<string[]> {
  if (!manifest.skills) {
    return [];
  }

  const neededVars = new Set<string>();
  for (const skillId of selectedSkills) {
    const def = manifest.skills[skillId];
    if (def?.env_vars) {
      for (const v of def.env_vars) {
        neededVars.add(v);
      }
    }
  }

  const envPairs: string[] = [];
  for (const varName of neededVars) {
    if (process.env[varName]) {
      envPairs.push(`${varName}=${process.env[varName]}`);
      continue;
    }

    const value = await p.text({
      message: `${varName} (required by selected skills)`,
      placeholder: `Enter ${varName}`,
      validate: (val) => {
        if (!val?.trim()) {
          return `${varName} is required`;
        }
        return undefined;
      },
    });

    if (p.isCancel(value) || !value?.trim()) {
      continue;
    }

    process.env[varName] = value.trim();
    envPairs.push(`${varName}=${value.trim()}`);
  }

  return envPairs;
}

// ─── Skill Installation ─────────────────────────────────────────────────────────

/** Install selected skills on the remote VM. */
export async function installSkills(
  runner: CloudRunner,
  manifest: Manifest,
  agentName: string,
  skillIds: string[],
): Promise<void> {
  if (!manifest.skills || skillIds.length === 0) {
    return;
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  const instructionSkills: Array<{
    id: string;
    path: string;
    content: string;
  }> = [];

  for (const skillId of skillIds) {
    const def = manifest.skills[skillId];
    if (!def) {
      continue;
    }
    const agentConfig = def.agents[agentName];
    if (!agentConfig) {
      continue;
    }

    // Run prerequisite commands before installation
    if (def.prerequisites?.commands) {
      for (const cmd of def.prerequisites.commands) {
        await asyncTryCatch(() => runner.runServer(cmd, 120));
      }
    }

    if (def.type === "mcp" && agentConfig.mcp_config) {
      mcpServers[skillId] = agentConfig.mcp_config;
    } else if (def.type === "instruction" && agentConfig.instruction_path && def.content) {
      instructionSkills.push({
        id: skillId,
        path: agentConfig.instruction_path,
        content: def.content,
      });
    }
  }

  const totalCount = Object.keys(mcpServers).length + instructionSkills.length;
  if (totalCount === 0) {
    return;
  }

  logStep(`Installing ${totalCount} skill(s)...`);

  // Install MCP skills — route to the correct agent config format
  if (Object.keys(mcpServers).length > 0) {
    if (agentName === "claude") {
      await installClaudeMcpServers(runner, mcpServers);
    } else if (agentName === "cursor") {
      await installCursorMcpServers(runner, mcpServers);
    } else {
      // Generic: try Claude-style settings.json, fall back to agent-specific paths
      logWarn(`MCP skills for ${agentName}: using generic install (may need manual config)`);
      await installGenericMcpServers(runner, agentName, mcpServers);
    }
  }

  // Install instruction skills (SKILL.md files)
  for (const skill of instructionSkills) {
    await injectInstructionSkill(runner, skill.id, skill.path, skill.content);
  }

  logInfo(`Skills installed: ${skillIds.join(", ")}`);
}

/** Merge MCP servers into Claude Code's ~/.claude/settings.json. */
export async function installClaudeMcpServers(
  runner: CloudRunner,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const tmpLocal = join(getTmpDir(), `claude_settings_${Date.now()}.json`);
  const dlResult = await asyncTryCatch(() => runner.downloadFile("$HOME/.claude/settings.json", tmpLocal));

  let settings: Record<string, unknown> = {};
  if (dlResult.ok) {
    const parsed = parseJsonObj(readFileSync(tmpLocal, "utf-8"));
    if (parsed) {
      settings = parsed;
    }
  }

  const existingMcp = toRecord(settings.mcpServers) ?? {};
  settings.mcpServers = {
    ...existingMcp,
    ...servers,
  };

  await uploadConfigFile(runner, JSON.stringify(settings, null, 2), "$HOME/.claude/settings.json");
}

/** Write MCP servers to Cursor's ~/.cursor/mcp.json. */
export async function installCursorMcpServers(
  runner: CloudRunner,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const tmpLocal = join(getTmpDir(), `cursor_mcp_${Date.now()}.json`);
  const dlResult = await asyncTryCatch(() => runner.downloadFile("$HOME/.cursor/mcp.json", tmpLocal));

  let config: Record<string, unknown> = {};
  if (dlResult.ok) {
    const parsed = parseJsonObj(readFileSync(tmpLocal, "utf-8"));
    if (parsed) {
      config = parsed;
    }
  }

  const existingMcp = toRecord(config.mcpServers) ?? {};
  config.mcpServers = {
    ...existingMcp,
    ...servers,
  };

  await uploadConfigFile(runner, JSON.stringify(config, null, 2), "$HOME/.cursor/mcp.json");
}

/** Generic MCP install — writes a .mcp.json in the agent's config directory. */
export async function installGenericMcpServers(
  runner: CloudRunner,
  agentName: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const config = JSON.stringify(
    {
      mcpServers: servers,
    },
    null,
    2,
  );
  await uploadConfigFile(runner, config, `$HOME/.${agentName}/mcp.json`);
}

/**
 * Append MCP server entries to Codex's ~/.codex/config.toml under
 * [mcp_servers.NAME] sections. Existing sections with the same name are
 * left untouched (we don't try to merge mid-file); new ones are appended.
 */
export async function installCodexMcpServers(
  runner: CloudRunner,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const tmpLocal = join(getTmpDir(), `codex_config_${Date.now()}.toml`);
  const dlResult = await asyncTryCatch(() => runner.downloadFile("$HOME/.codex/config.toml", tmpLocal));

  let existing = "";
  if (dlResult.ok) {
    const readResult = tryCatch(() => readFileSync(tmpLocal, "utf-8"));
    if (readResult.ok) {
      existing = readResult.data;
    }
  }

  const existingNames = new Set<string>();
  for (const m of existing.matchAll(/^\[mcp_servers\.([^.\]]+)\]/gm)) {
    existingNames.add(m[1]);
  }

  const lines: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (existingNames.has(name)) {
      continue;
    }
    lines.push("");
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${tomlString(cfg.command)}`);
    lines.push(`args = [${cfg.args.map((a) => tomlString(a)).join(", ")}]`);
    if (cfg.env) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, val] of Object.entries(cfg.env)) {
        lines.push(`${k} = ${tomlString(val)}`);
      }
    }
  }

  if (lines.length === 0) {
    return;
  }

  const merged = `${existing.replace(/\n+$/, "")}\n${lines.join("\n")}\n`;
  await uploadConfigFile(runner, merged, "$HOME/.codex/config.toml");
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Inject an instruction skill (SKILL.md) onto the remote VM. */
async function injectInstructionSkill(
  runner: CloudRunner,
  skillId: string,
  remotePath: string,
  content: string,
): Promise<void> {
  // Validate remotePath to prevent path traversal and shell injection
  const pathResult = tryCatch(() => validateRemotePath(remotePath));
  if (!pathResult.ok) {
    logWarn(`Skill ${skillId}: invalid remote path "${remotePath}", skipping`);
    return;
  }
  const safePath = pathResult.data;

  const b64 = Buffer.from(content).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
    logWarn(`Skill ${skillId}: unexpected characters in base64 output, skipping`);
    return;
  }

  const safeDir = safePath.slice(0, safePath.lastIndexOf("/"));
  const cmd = `mkdir -p ${shellQuote(safeDir)} && printf '%s' '${b64}' | base64 -d > ${shellQuote(safePath)} && chmod 644 ${shellQuote(safePath)}`;

  const result = await asyncTryCatch(() => runner.runServer(cmd));
  if (result.ok) {
    logInfo(`Skill injected: ${safePath}`);
  } else {
    logWarn(`Skill ${skillId} injection failed — agent will work without it`);
  }
}
