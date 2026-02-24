// shared/orchestrate.ts — Shared orchestration pipeline for deploying agents
// Each cloud implements CloudOrchestrator and calls runOrchestration().

import type { AgentConfig } from "./agents";
import { generateEnvConfig } from "./agents";
import { logInfo, logStep, logWarn, withRetry, prepareStdinForHandoff } from "./ui";
import { getOrPromptApiKey, getModelIdInteractive } from "./oauth";
import type { CloudRunner } from "./agent-setup";
import { offerGithubAuth, wrapSshCall } from "./agent-setup";

export interface CloudOrchestrator {
  cloudName: string;
  cloudLabel: string;
  runner: CloudRunner;
  authenticate(): Promise<void>;
  promptSize(): Promise<void>;
  createServer(name: string): Promise<void>;
  getServerName(): Promise<string>;
  waitForReady(): Promise<void>;
  interactiveSession(cmd: string): Promise<number>;
  saveLaunchCmd(launchCmd: string): void;
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

export async function runOrchestration(cloud: CloudOrchestrator, agent: AgentConfig, agentName: string): Promise<void> {
  logInfo(`${agent.name} on ${cloud.cloudLabel}`);
  process.stderr.write("\n");

  // 1. Authenticate with cloud provider
  await cloud.authenticate();

  // 2. Pre-provision hooks
  if (agent.preProvision) {
    try {
      await agent.preProvision();
    } catch {
      // non-fatal
    }
  }

  // 3. Get API key (before provisioning so user isn't waiting)
  const apiKey = await getOrPromptApiKey(agentName, cloud.cloudName);

  // 4. Model selection (if agent needs it)
  let modelId: string | undefined;
  if (agent.modelPrompt) {
    modelId = await getModelIdInteractive(agent.modelDefault || "openrouter/auto", agent.name);
  }

  // 5. Size/bundle selection
  await cloud.promptSize();

  // 6. Provision server
  const serverName = await cloud.getServerName();
  await cloud.createServer(serverName);

  // 7. Wait for readiness
  await cloud.waitForReady();

  const envContent = generateEnvConfig(agent.envVars(apiKey));

  if (agent.setup) {
    // Batched path: install + env + config in a single SSH session
    await agent.setup(envContent, apiKey, modelId);
  } else {
    // 8. Install agent
    await agent.install();

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
  }

  // GitHub CLI setup
  await offerGithubAuth(cloud.runner);

  // 11. Pre-launch hooks (e.g. OpenClaw gateway)
  if (agent.preLaunch) {
    await agent.preLaunch();
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
  cloud.saveLaunchCmd(launchCmd);

  // Wrap in restart loop for cloud VMs — not for local execution
  const sessionCmd = cloud.cloudName === "local" ? launchCmd : wrapWithRestartLoop(launchCmd);
  const exitCode = await cloud.interactiveSession(sessionCmd);
  process.exit(exitCode);
}
