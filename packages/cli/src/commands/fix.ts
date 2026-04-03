import type { SpawnRecord } from "../history.js";
import type { Manifest } from "../manifest.js";
import type { CloudRunner } from "../shared/agent-setup.js";

import * as p from "@clack/prompts";
import { getErrorMessage, isString } from "@openrouter/spawn-shared";
import pc from "picocolors";
import { getActiveServers } from "../history.js";
import { loadManifest } from "../manifest.js";
import { validateConnectionIP, validateIdentifier, validateServerIdentifier, validateUsername } from "../security.js";
import { createCloudAgents, setupAutoUpdate, wrapSshCall } from "../shared/agent-setup.js";
import { generateEnvConfig } from "../shared/agents.js";
import { loadSavedOpenRouterKey } from "../shared/oauth.js";
import { injectEnvVarsToRunner } from "../shared/orchestrate.js";
import { getHistoryPath } from "../shared/paths.js";
import { asyncTryCatch, tryCatch } from "../shared/result.js";
import { ensureSshKeys, getSshKeyOpts } from "../shared/ssh-keys.js";
import { makeSshRunner } from "../shared/ssh-runner.js";
import { logWarn, withRetry } from "../shared/ui.js";
import { buildRecordLabel, buildRecordSubtitle } from "./list.js";
import { handleCancel, isInteractiveTTY } from "./shared.js";

/** Resolve ${VAR} template references from process.env. */
function resolveEnvTemplate(template: string): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const envName = isString(name) ? name : "";
    return process.env[envName] ?? "";
  });
}

/** Build the env var pairs array for generateEnvConfig, resolving templates. */
function buildEnvPairs(agentEnv: Record<string, string>): string[] {
  return Object.entries(agentEnv).map(([key, template]) => `${key}=${resolveEnvTemplate(template)}`);
}

/** Fix options — injectable for testing. */
export interface FixOptions {
  /** Override the CloudRunner (injectable for tests instead of real SSH). */
  makeRunner?: (ip: string, user: string, keyOpts: string[]) => CloudRunner;
}

/**
 * Run the full fix pipeline on a remote VM:
 * 1. Re-inject env vars + ensure shell rc files source ~/.spawnrc
 * 2. Reinstall agent (same install() as provisioning)
 * 3. Configure agent (settings files, etc.)
 * 4. Set up auto-update timer
 * 5. Start daemons (OpenClaw gateway, Cursor proxy, etc.)
 * 6. Verify agent binary is in PATH
 */
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
    validateIdentifier(record.agent, "Agent name");
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

  const agentManifest = man.agents[record.agent];
  if (!agentManifest) {
    p.log.error(`Unknown agent: ${pc.bold(record.agent)}`);
    p.log.info("This spawn may have been created with an agent that no longer exists.");
    return;
  }

  // Ensure OPENROUTER_API_KEY is available
  if (!process.env.OPENROUTER_API_KEY) {
    const savedKey = loadSavedOpenRouterKey();
    if (savedKey) {
      process.env.OPENROUTER_API_KEY = savedKey;
    } else {
      p.log.error("No OpenRouter API key found.");
      p.log.info("Set OPENROUTER_API_KEY in your environment, or run a new spawn to authenticate via OAuth.");
      return;
    }
  }
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";

  const label = record.name || conn.server_name || conn.ip;
  const agentDisplayName = agentManifest.name;

  p.log.step(`Fixing ${pc.bold(agentDisplayName)} on ${pc.bold(label)}...`);
  p.log.info(`Connecting to ${pc.dim(`${conn.user}@${conn.ip}`)}`);
  console.log();

  // Create SSH runner (or use injected one for tests)
  const keyOpts = options?.makeRunner ? [] : getSshKeyOpts(await ensureSshKeys());
  const runner = options?.makeRunner
    ? options.makeRunner(conn.ip, conn.user, keyOpts)
    : makeSshRunner(conn.ip, conn.user, keyOpts);

  // Resolve the agent config with full install/configure/preLaunch functions
  const { resolveAgent } = createCloudAgents(runner);
  const agentResult = tryCatch(() => resolveAgent(record.agent));
  if (!agentResult.ok) {
    p.log.error(`Unknown agent: ${pc.bold(record.agent)}`);
    return;
  }
  const agent = agentResult.data;

  // --- Phase 1: Re-inject env vars + ensure rc files source ~/.spawnrc ---
  const envPairs = buildEnvPairs(agentManifest.env ?? {});
  const envContent = generateEnvConfig(envPairs);
  const envResult = await asyncTryCatch(() => injectEnvVarsToRunner(runner, envContent));
  if (!envResult.ok) {
    logWarn(`Environment setup had errors: ${getErrorMessage(envResult.error)}`);
  }

  // --- Phase 2: Reinstall agent ---
  const installResult = await asyncTryCatch(() => agent.install());
  if (!installResult.ok) {
    logWarn(`Agent install had errors: ${getErrorMessage(installResult.error)}`);
    p.log.info("Continuing with remaining fix steps...");
  }

  // --- Phase 3: Configure agent (settings files, etc.) ---
  if (agent.configure) {
    const configResult = await asyncTryCatch(() =>
      withRetry("agent config", () => wrapSshCall(agent.configure!(apiKey)), 2, 5),
    );
    if (!configResult.ok) {
      logWarn("Agent configuration had errors (continuing with defaults)");
    }
  }

  // --- Phase 4: Auto-update timer ---
  if (agent.updateCmd) {
    const updateResult = await asyncTryCatch(() => setupAutoUpdate(runner, record.agent, agent.updateCmd!));
    if (!updateResult.ok) {
      logWarn("Auto-update setup had errors (non-fatal)");
    }
  }

  // --- Phase 5: Start daemons (preLaunch) ---
  if (agent.preLaunch) {
    const preLaunchResult = await asyncTryCatch(() => agent.preLaunch!());
    if (!preLaunchResult.ok) {
      logWarn(`Pre-launch setup had errors: ${getErrorMessage(preLaunchResult.error)}`);
      p.log.info("You may need to start the agent daemon manually.");
    }
  }

  // --- Phase 6: Verify agent binary ---
  const binaryName = (agentManifest.launch ?? record.agent).split(/\s+/)[0];
  // SECURITY: validate binaryName before use in shell command — launch field comes from manifest
  validateIdentifier(binaryName, "Agent binary name");
  const verifyResult = await asyncTryCatch(() => runner.runServer(`command -v ${binaryName} >/dev/null 2>&1`));
  if (!verifyResult.ok) {
    logWarn(`Agent binary '${binaryName}' not found in PATH after fix`);
    p.log.info("The agent may need a manual reinstall or PATH adjustment.");
  }

  console.log();
  p.log.success(`${pc.bold(agentDisplayName)} fixed successfully!`);
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
      process.exit(1);
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
    process.exit(1);
  }

  // Interactive picker: show active servers and let user choose
  const pickerOptions = servers.map((r) => ({
    value: r.id || r.timestamp,
    label: buildRecordLabel(r),
    hint: buildRecordSubtitle(r, manifest),
  }));

  const selected = await p.select({
    message: "Select a spawn to fix",
    options: pickerOptions,
  });

  if (p.isCancel(selected)) {
    handleCancel();
  }

  const record = servers.find((r) => (r.id || r.timestamp) === selected);
  if (!record) {
    p.log.error("Spawn not found.");
    process.exit(1);
  }

  await fixSpawn(record, manifest, options);
}
