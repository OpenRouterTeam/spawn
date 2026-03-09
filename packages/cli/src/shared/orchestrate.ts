// shared/orchestrate.ts — Shared orchestration pipeline for deploying agents
// Each cloud implements CloudOrchestrator and calls runOrchestration().

import type { VMConnection } from "../history.js";
import type { CloudRunner } from "./agent-setup";
import type { AgentConfig } from "./agents";

import { generateSpawnId, saveLaunchCmd, saveSpawnRecord } from "../history.js";
import { offerGithubAuth, wrapSshCall } from "./agent-setup";
import { tryTarballInstall } from "./agent-tarball";
import { generateEnvConfig } from "./agents";
import { getOrPromptApiKey } from "./oauth";
import { logInfo, logStep, logWarn, prepareStdinForHandoff, withRetry } from "./ui";

export interface CloudOrchestrator {
  cloudName: string;
  cloudLabel: string;
  runner: CloudRunner;
  /** When true, skip tarball + agent install (e.g. booting from a pre-baked snapshot). */
  skipAgentInstall?: boolean;
  authenticate(): Promise<void>;
  checkAccountReady?(): Promise<void>;
  promptSize(): Promise<void>;
  createServer(name: string): Promise<VMConnection>;
  getServerName(): Promise<string>;
  waitForReady(): Promise<void>;
  interactiveSession(cmd: string): Promise<number>;
}

/**
 * Wrap a launch command in a restart loop for cloud VMs.
 * Restarts the agent on non-zero exit (crash, SIGTERM, OOM) up to MAX_RESTARTS times.
 * Clean exits (exit code 0) break out of the loop immediately.
 * Skipped for local execution where the user controls the process directly.
 */
function wrapWithRestartLoop(cmd: string): string {
  // Shell restart loop — bash 3.x compatible (no ((var++)), no set -u)
  return [
    "_spawn_restarts=0",
    "_spawn_max=10",
    'while [ "$_spawn_restarts" -lt "$_spawn_max" ]; do',
    `  ${cmd}`,
    "  _spawn_exit=$?",
    '  if [ "$_spawn_exit" -eq 0 ]; then break; fi',
    "  _spawn_restarts=$((_spawn_restarts + 1))",
    '  printf "\\n[spawn] Agent exited with code %d. Restarting in 5s (%d/%d)...\\n" "$_spawn_exit" "$_spawn_restarts" "$_spawn_max" >&2',
    "  sleep 5",
    "done",
    'if [ "$_spawn_restarts" -ge "$_spawn_max" ]; then',
    '  printf "\\n[spawn] Agent crashed %d times. Giving up.\\n" "$_spawn_max" >&2',
    "fi",
    'exit "${_spawn_exit:-0}"',
  ].join("\n");
}

/** Options for runOrchestration (used in tests to inject mock dependencies). */
export interface OrchestrationOptions {
  tryTarball?: (runner: CloudRunner, agentName: string) => Promise<boolean>;
}

export async function runOrchestration(
  cloud: CloudOrchestrator,
  agent: AgentConfig,
  agentName: string,
  options?: OrchestrationOptions,
): Promise<void> {
  logInfo(`${agent.name} on ${cloud.cloudLabel}`);
  process.stderr.write("\n");

  // 1. Authenticate with cloud provider
  await cloud.authenticate();

  // 1b. Pre-flight account readiness check (billing, email verification, etc.)
  if (cloud.checkAccountReady) {
    try {
      await cloud.checkAccountReady();
    } catch {
      // non-fatal — let createServer be the final arbiter
    }
  }

  // 2. Get API key (immediately after cloud auth — before any other prompts
  //    so the "opening browser" message leads directly to OpenRouter OAuth)
  const apiKey = await getOrPromptApiKey(agentName, cloud.cloudName);

  // 3. Pre-provision hooks (e.g., GitHub auth prompt — non-fatal)
  if (agent.preProvision) {
    try {
      await agent.preProvision();
    } catch {
      // non-fatal
    }
  }

  // 4. Model ID (use agent default — no interactive prompt)
  const modelId = agent.modelDefault || process.env.MODEL_ID;

  // 5. Size/bundle selection
  await cloud.promptSize();

  // 6. Provision server
  const spawnId = generateSpawnId();
  const serverName = await cloud.getServerName();
  const connection = await cloud.createServer(serverName);

  // 6b. Record the spawn atomically with connection data
  const spawnName = process.env.SPAWN_NAME_KEBAB || process.env.SPAWN_NAME || undefined;
  saveSpawnRecord({
    id: spawnId,
    agent: agentName,
    cloud: cloud.cloudName,
    timestamp: new Date().toISOString(),
    ...(spawnName
      ? {
          name: spawnName,
        }
      : {}),
    connection,
  });

  // 7. Wait for readiness
  await cloud.waitForReady();

  const envContent = generateEnvConfig(agent.envVars(apiKey));

  // 8. Install agent (skip entirely for snapshot boots, try tarball first on cloud VMs)
  if (cloud.skipAgentInstall) {
    logInfo("Snapshot boot — skipping agent install");
  } else {
    let installedFromTarball = false;
    if (cloud.cloudName !== "local" && !agent.skipTarball) {
      const tarball = options?.tryTarball ?? tryTarballInstall;
      installedFromTarball = await tarball(cloud.runner, agentName);
    }
    if (!installedFromTarball) {
      await agent.install();
    }
  }

  // 9. Inject environment variables via .spawnrc
  logStep("Setting up environment variables...");
  const envB64 = Buffer.from(envContent).toString("base64");
  try {
    await withRetry(
      "env setup",
      () =>
        wrapSshCall(
          cloud.runner.runServer(
            `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc; ` +
              `grep -q 'source ~/.spawnrc' ~/.bashrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.bashrc; ` +
              `grep -q 'source ~/.spawnrc' ~/.zshrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.zshrc`,
          ),
        ),
      2,
      5,
    );
  } catch {
    logWarn("Environment setup had errors");
  }

  // 10. Agent-specific configuration
  if (agent.configure) {
    try {
      await withRetry("agent config", () => wrapSshCall(agent.configure!(apiKey, modelId)), 2, 5);
    } catch {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // GitHub CLI setup
  await offerGithubAuth(cloud.runner);

  // 11. Pre-launch hooks (e.g. OpenClaw gateway)
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 11b. Agent-specific pre-launch tip (e.g. channel setup ordering hint)
  if (agent.preLaunchMsg) {
    process.stderr.write("\n");
    logInfo(`Tip: ${agent.preLaunchMsg}`);
  }

  // 12. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logInfo(`${cloud.cloudLabel} setup completed successfully!`);
  process.stderr.write("\n");
  logStep("Starting agent...");

  // Clean up stdin state accumulated during provisioning (readline, @clack/prompts
  // raw mode, keypress listeners) so Bun.spawn gets a pristine FD handoff
  prepareStdinForHandoff();

  const launchCmd = agent.launchCmd();
  saveLaunchCmd(launchCmd, spawnId);

  // Wrap in restart loop for cloud VMs — not for local execution
  const sessionCmd = cloud.cloudName === "local" ? launchCmd : wrapWithRestartLoop(launchCmd);
  const exitCode = await cloud.interactiveSession(sessionCmd);
  process.exit(exitCode);
}
