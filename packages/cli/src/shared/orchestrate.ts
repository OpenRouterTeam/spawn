// shared/orchestrate.ts — Shared orchestration pipeline for deploying agents
// Each cloud implements CloudOrchestrator and calls runOrchestration().

import type { CloudRunner } from "./agent-setup";
import type { AgentConfig } from "./agents";

import { generateSpawnId, saveSpawnRecord } from "../history.js";
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
  createServer(name: string, spawnId?: string): Promise<void>;
  getServerName(): Promise<string>;
  waitForReady(): Promise<void>;
  interactiveSession(cmd: string): Promise<number>;
  saveLaunchCmd(launchCmd: string, spawnId?: string): void;
}

/**
 * Wrap a launch command in a tmux session for cloud VMs.
 * - First connect: creates tmux session "spawn", runs the agent inside it
 * - Reconnect: attaches to existing session (picks up where user left off)
 * - Ctrl+C exits the agent → user lands at a shell prompt inside tmux
 * - SSH disconnect → tmux session persists, `spawn last` reattaches
 * Skipped for local execution where the user controls the process directly.
 */
export function wrapWithTmux(cmd: string): string {
  const escaped = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  return [
    "tmux attach-session -t spawn 2>/dev/null",
    "|| {",
    "tmux new-session -s spawn -d &&",
    "tmux set -t spawn status off &&",
    `tmux send-keys -t spawn "${escaped}" Enter &&`,
    "tmux attach-session -t spawn;",
    "}",
  ].join(" ");
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
  await cloud.createServer(serverName, spawnId);

  // 6b. Record the spawn now that the server exists
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
              `grep -q 'source ~/.spawnrc' ~/.zshrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.zshrc; ` +
              "command -v tmux >/dev/null 2>&1 || { sudo apt-get install -y -qq tmux 2>/dev/null || apt-get install -y -qq tmux 2>/dev/null; }",
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
  cloud.saveLaunchCmd(launchCmd, spawnId);

  // Wrap in tmux for cloud VMs — Ctrl+C lands at shell, SSH reconnect reattaches
  const sessionCmd = cloud.cloudName === "local" ? launchCmd : wrapWithTmux(launchCmd);
  const exitCode = await cloud.interactiveSession(sessionCmd);
  process.exit(exitCode);
}
