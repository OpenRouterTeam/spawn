// shared/skills.ts — Skill installation for --beta skills
// Pre-installs MCP servers and tools on remote VMs during agent setup.

import type { Manifest, McpServerConfig } from "../manifest.js";
import type { CloudRunner } from "./agent-setup.js";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { toRecord } from "@openrouter/spawn-shared";
import { uploadConfigFile } from "./agent-setup.js";
import { parseJsonObj } from "./parse.js";
import { getTmpDir } from "./paths.js";
import { asyncTryCatch } from "./result.js";
import { logInfo, logStep, logWarn } from "./ui.js";

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

  // Collect all required env vars across selected skills
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
    // Skip if already set in environment
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

  // Collect MCP configs for this agent
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const skillId of skillIds) {
    const def = manifest.skills[skillId];
    if (!def) {
      continue;
    }
    const agentConfig = def.agents[agentName];
    if (!agentConfig?.mcp_config) {
      continue;
    }
    // Use skill ID as the MCP server name (e.g. "github-mcp")
    mcpServers[skillId] = agentConfig.mcp_config;
  }

  if (Object.keys(mcpServers).length === 0) {
    return;
  }

  logStep(`Installing ${Object.keys(mcpServers).length} skill(s)...`);

  if (agentName === "claude") {
    await installClaudeMcpServers(runner, mcpServers);
  } else if (agentName === "cursor") {
    await installCursorMcpServers(runner, mcpServers);
  } else {
    logWarn(`Skills not yet supported for agent: ${agentName}`);
    return;
  }

  logInfo(`Skills installed: ${skillIds.join(", ")}`);
}

/** Merge MCP servers into Claude Code's ~/.claude/settings.json. */
async function installClaudeMcpServers(runner: CloudRunner, servers: Record<string, McpServerConfig>): Promise<void> {
  // Download existing settings.json from remote
  const tmpLocal = join(getTmpDir(), `claude_settings_${Date.now()}.json`);
  const dlResult = await asyncTryCatch(() => runner.downloadFile("$HOME/.claude/settings.json", tmpLocal));

  let settings: Record<string, unknown> = {};
  if (dlResult.ok) {
    const parsed = parseJsonObj(readFileSync(tmpLocal, "utf-8"));
    if (parsed) {
      settings = parsed;
    }
  }

  // Merge mcpServers into existing settings
  const existingMcp = toRecord(settings.mcpServers) ?? {};
  settings.mcpServers = {
    ...existingMcp,
    ...servers,
  };

  // Re-upload merged settings
  await uploadConfigFile(runner, JSON.stringify(settings, null, 2), "$HOME/.claude/settings.json");
}

/** Write MCP servers to Cursor's ~/.cursor/mcp.json. */
async function installCursorMcpServers(runner: CloudRunner, servers: Record<string, McpServerConfig>): Promise<void> {
  // Download existing mcp.json if it exists
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
