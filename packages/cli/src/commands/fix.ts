import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";

import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getActiveServers } from "../history.js";
import { loadManifest } from "../manifest.js";
import { validateConnectionIP, validateServerIdentifier, validateUsername } from "../security.js";
import { getHistoryPath } from "../shared/paths.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { SSH_INTERACTIVE_OPTS } from "../shared/ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { isString } from "../shared/type-guards.js";
import { buildRecordLabel, buildRecordSubtitle } from "./list.js";
import { getErrorMessage, handleCancel, isInteractiveTTY } from "./shared.js";

/** Shell-escape a value for safe embedding in a single-quoted string. */
function shellSingleQuote(value: string): string {
  // Replace ' with '\'' — exit quote, insert literal ', re-enter quote
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Resolve ${VAR} template references from process.env. */
function resolveEnvTemplate(template: string): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envName = isString(name) ? name : "";
    return process.env[envName] ?? "";
  });
}

/** Build a bash script to re-inject env vars and reinstall the agent remotely. */
export function buildFixScript(manifest: Manifest, agentKey: string): string {
  const agentDef = manifest.agents[agentKey];
  if (!agentDef) {
    throw new Error(`Unknown agent: ${agentKey}`);
  }

  const lines: string[] = [
    "#!/bin/bash",
    "set -eo pipefail",
    "",
  ];

  // Re-inject env vars into ~/.spawnrc
  const env = agentDef.env ?? {};
  const envEntries = Object.entries(env);
  if (envEntries.length > 0) {
    lines.push("echo '==> Re-injecting credentials...'");
    // Write new .spawnrc atomically: write to .new then mv into place
    lines.push("{");
    for (const [key, template] of envEntries) {
      const value = resolveEnvTemplate(template);
      lines.push(`  printf 'export %s=%s\\n' ${shellSingleQuote(key)} ${shellSingleQuote(value)}`);
    }
    lines.push("} > ~/.spawnrc.new");
    lines.push("mv ~/.spawnrc.new ~/.spawnrc");
    lines.push("chmod 600 ~/.spawnrc");
    lines.push("echo '    Credentials updated in ~/.spawnrc'");
    lines.push("");
  }

  // Re-run the agent's install command to get the latest version
  const installCmd = agentDef.install;
  if (installCmd) {
    lines.push("echo '==> Re-installing agent (latest version)...'");
    lines.push(installCmd);
    lines.push("echo '    Agent reinstalled successfully'");
    lines.push("");
  }

  const launchCmd = agentDef.launch ?? agentKey;
  lines.push("echo '==> Done! Your spawn is ready.'");
  lines.push(`echo "    Run '${launchCmd}' inside the VM to start the agent."`);

  return lines.join("\n") + "\n";
}

/** Dependency-injectable SSH fix script runner type. */
export type FixScriptRunner = (ip: string, user: string, script: string, keyOpts: string[]) => Promise<boolean>;

/** Run the fix script on a remote VM by piping it to SSH's stdin. */
async function defaultRunFixScript(ip: string, user: string, script: string, keyOpts: string[]): Promise<boolean> {
  const result = spawnSync(
    "ssh",
    [
      ...SSH_INTERACTIVE_OPTS,
      ...keyOpts,
      `${user}@${ip}`,
      "--",
      "bash -s",
    ],
    {
      input: script,
      stdio: [
        "pipe",
        "inherit",
        "inherit",
      ],
      encoding: "utf8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  return (result.status ?? 1) === 0;
}

/** Fix options — injectable for testing. */
export interface FixOptions {
  /** Override the SSH script runner (injectable for tests). */
  runScript?: FixScriptRunner;
}

/** Fix a specific spawn: re-inject env vars and reinstall agent on the VM. */
export async function fixSpawn(record: SpawnRecord, manifest: Manifest | null, options?: FixOptions): Promise<void> {
  const conn = record.connection;
  if (!conn) {
    p.log.error("Cannot fix: spawn has no connection information.");
    p.log.info("This usually means provisioning failed before SSH was established.");
    return;
  }
  if (conn.deleted) {
    p.log.error("Cannot fix: server has been deleted.");
    return;
  }
  if (conn.ip === "sprite-console") {
    p.log.error("Cannot fix: Sprite console connections are not supported by 'spawn fix'.");
    p.log.info("SSH directly into the VM and re-run the setup script manually.");
    return;
  }

  // SECURITY: validate all connection fields before use
  const validationResult = tryCatch(() => {
    validateConnectionIP(conn.ip);
    validateUsername(conn.user);
    if (conn.server_name) {
      validateServerIdentifier(conn.server_name);
    }
    if (conn.server_id) {
      validateServerIdentifier(conn.server_id);
    }
  });
  if (!validationResult.ok) {
    p.log.error(`Security validation failed: ${getErrorMessage(validationResult.error)}`);
    p.log.info("Your spawn history file may be corrupted or tampered with.");
    p.log.info(`Location: ${getHistoryPath()}`);
    return;
  }

  // Load manifest if not provided
  let man = manifest;
  if (!man) {
    const manifestResult = await asyncTryCatch(() => loadManifest());
    if (!manifestResult.ok) {
      p.log.error(`Failed to load manifest: ${getErrorMessage(manifestResult.error)}`);
      return;
    }
    man = manifestResult.data;
  }

  const agentDef = man.agents[record.agent];
  if (!agentDef) {
    p.log.error(`Unknown agent: ${pc.bold(record.agent)}`);
    p.log.info("This spawn may have been created with an agent that no longer exists.");
    return;
  }

  // Build the remote fix script
  const scriptResult = tryCatch(() => buildFixScript(man!, record.agent));
  if (!scriptResult.ok) {
    p.log.error(`Failed to build fix script: ${getErrorMessage(scriptResult.error)}`);
    return;
  }
  const script = scriptResult.data;

  const label = record.name || conn.server_name || conn.ip;
  const agentName = agentDef.name;

  p.log.step(`Fixing ${pc.bold(agentName)} on ${pc.bold(label)}...`);
  p.log.info(`Connecting to ${pc.dim(`${conn.user}@${conn.ip}`)}`);
  console.log();

  const runner = options?.runScript ?? defaultRunFixScript;
  const keyOpts = options?.runScript ? [] : getSshKeyOpts(await ensureSshKeys());
  const fixResult = await asyncTryCatch(() => runner(conn.ip, conn.user, script, keyOpts));

  console.log();

  if (!fixResult.ok) {
    p.log.error(`Fix failed: ${getErrorMessage(fixResult.error)}`);
    p.log.info(`Try manually: ${pc.cyan(`ssh ${conn.user}@${conn.ip}`)}`);
    return;
  }

  if (!fixResult.data) {
    p.log.error("Fix script exited with an error. Check the output above for details.");
    p.log.info(`Try manually: ${pc.cyan(`ssh ${conn.user}@${conn.ip}`)}`);
    return;
  }

  p.log.success(`${pc.bold(agentName)} fixed successfully!`);
  p.log.info(`Reconnect: ${pc.cyan("spawn last")}`);
}

export async function cmdFix(spawnId?: string, options?: FixOptions): Promise<void> {
  const servers = getActiveServers();

  if (servers.length === 0) {
    p.log.info("No active spawns to fix.");
    p.log.info(`Run ${pc.cyan("spawn <agent> <cloud>")} to create a spawn first.`);
    return;
  }

  const manifestResult = await asyncTryCatch(() => loadManifest());
  const manifest = manifestResult.ok ? manifestResult.data : null;

  // If a specific name/id is given, find and fix it directly
  if (spawnId) {
    const record = servers.find((r) => r.id === spawnId || r.name === spawnId || r.connection?.server_name === spawnId);
    if (!record) {
      p.log.error(`Spawn not found: ${pc.bold(spawnId)}`);
      p.log.info(`Run ${pc.cyan("spawn list")} to see your active spawns.`);
      return;
    }
    await fixSpawn(record, manifest, options);
    return;
  }

  // Only one server — fix it directly without prompting (works in non-interactive mode too)
  if (servers.length === 1) {
    await fixSpawn(servers[0], manifest, options);
    return;
  }

  // Non-interactive fallback (multiple servers require picking)
  if (!isInteractiveTTY()) {
    p.log.error("spawn fix requires an interactive terminal or a spawn name/ID.");
    p.log.info(`Usage: ${pc.cyan("spawn fix <spawn-id>")}`);
    return;
  }

  // Interactive picker: show active servers and let user choose
  const options2 = servers.map((r) => ({
    value: r.id || r.timestamp,
    label: buildRecordLabel(r),
    hint: buildRecordSubtitle(r, manifest),
  }));

  const selected = await p.select({
    message: "Select a spawn to fix",
    options: options2,
  });

  if (p.isCancel(selected)) {
    handleCancel();
  }

  const record = servers.find((r) => (r.id || r.timestamp) === selected);
  if (!record) {
    p.log.error("Spawn not found.");
    return;
  }

  await fixSpawn(record, manifest, options);
}
