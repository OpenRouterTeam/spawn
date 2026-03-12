// shared/orchestrate.ts — Shared orchestration pipeline for deploying agents
// Each cloud implements CloudOrchestrator and calls runOrchestration().

import type { VMConnection } from "../history.js";
import type { CloudRunner } from "./agent-setup";
import type { AgentConfig } from "./agents";
import type { SshTunnelHandle } from "./ssh";

import { generateSpawnId, saveLaunchCmd, saveSpawnRecord } from "../history.js";
import { offerGithubAuth, wrapSshCall } from "./agent-setup";
import { tryTarballInstall } from "./agent-tarball";
import { generateEnvConfig } from "./agents";
import { getOrPromptApiKey } from "./oauth";
import { asyncTryCatch, asyncTryCatchIf, isOperationalError } from "./result.js";
import { startSshTunnel } from "./ssh";
import { ensureSshKeys, getSshKeyOpts } from "./ssh-keys";
import { getErrorMessage } from "./type-guards";
import {
  logDebug,
  logInfo,
  logStep,
  logWarn,
  openBrowser,
  prepareStdinForHandoff,
  validateModelId,
  withRetry,
} from "./ui";

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
  /** Return SSH connection info for tunnel support. Omit for non-SSH clouds. */
  getConnectionInfo?(): {
    host: string;
    user: string;
  };
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
  getApiKey?: (agentSlug?: string, cloudSlug?: string) => Promise<string>;
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
  //     Uses try/catch (not guarded) because hooks can throw ANY provider-specific error.
  if (cloud.checkAccountReady) {
    const r = await asyncTryCatch(() => cloud.checkAccountReady!());
    if (!r.ok) {
      logWarn("Account readiness check failed — proceeding anyway");
      logDebug(getErrorMessage(r.error));
    }
  }

  // 2. Get API key (immediately after cloud auth — before any other prompts
  //    so the "opening browser" message leads directly to OpenRouter OAuth)
  const resolveApiKey = options?.getApiKey ?? getOrPromptApiKey;
  const apiKey = await resolveApiKey(agentName, cloud.cloudName);

  // 3. Pre-provision hooks (e.g., GitHub auth prompt — non-fatal)
  //     Uses try/catch (not guarded) because hooks can throw ANY provider-specific error.
  if (agent.preProvision) {
    const r = await asyncTryCatch(() => agent.preProvision!());
    if (!r.ok) {
      logWarn("Pre-provision hook failed — continuing");
      logDebug(getErrorMessage(r.error));
    }
  }

  // 4. Model ID (use agent default — no interactive prompt)
  const rawModelId = agent.modelDefault || process.env.MODEL_ID;
  const modelId = rawModelId && validateModelId(rawModelId) ? rawModelId : undefined;
  if (rawModelId && !modelId) {
    logWarn(`Ignoring invalid MODEL_ID: ${rawModelId}`);
  }

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
    const betaFeatures = new Set((process.env.SPAWN_BETA ?? "").split(",").filter(Boolean));
    if (cloud.cloudName !== "local" && !agent.skipTarball && betaFeatures.has("tarball")) {
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
  const envResult = await asyncTryCatch(() =>
    withRetry(
      "env setup",
      () =>
        wrapSshCall(
          cloud.runner.runServer(
            `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc; ` +
              "for _rc in ~/.bashrc ~/.profile ~/.bash_profile ~/.zshrc; do " +
              `grep -q 'source ~/.spawnrc' "$_rc" 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> "$_rc"; ` +
              "done",
          ),
        ),
      2,
      5,
    ),
  );
  if (!envResult.ok) {
    logWarn("Environment setup had errors");
  }

  // 10. Parse enabled setup steps from env (set by interactive/run prompts)
  let enabledSteps: Set<string> | undefined;
  const stepsEnv = process.env.SPAWN_ENABLED_STEPS;
  if (stepsEnv !== undefined) {
    enabledSteps = new Set(stepsEnv.split(",").filter(Boolean));
  }

  // 10b. Agent-specific configuration
  if (agent.configure) {
    const configResult = await asyncTryCatch(() =>
      withRetry("agent config", () => wrapSshCall(agent.configure!(apiKey, modelId, enabledSteps)), 2, 5),
    );
    if (!configResult.ok) {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // GitHub CLI setup (skip if user unchecked in setup options)
  if (!enabledSteps || enabledSteps.has("github")) {
    await offerGithubAuth(cloud.runner);
  }

  // 11. Pre-launch hooks (e.g. OpenClaw gateway)
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 11b. SSH tunnel for web dashboard
  let tunnelHandle: SshTunnelHandle | undefined;
  if (agent.tunnel) {
    if (cloud.getConnectionInfo) {
      // SSH-based cloud: tunnel the remote port to localhost
      const tunnelResult = await asyncTryCatchIf(isOperationalError, async () => {
        const conn = cloud.getConnectionInfo();
        const keys = await ensureSshKeys();
        tunnelHandle = await startSshTunnel({
          host: conn.host,
          user: conn.user,
          remotePort: agent.tunnel.remotePort,
          sshKeyOpts: getSshKeyOpts(keys),
        });
        if (agent.tunnel.browserUrl) {
          const url = agent.tunnel.browserUrl(tunnelHandle.localPort);
          if (url) {
            openBrowser(url);
          }
        }
      });
      if (!tunnelResult.ok) {
        logWarn("Web dashboard tunnel failed — use the TUI instead");
      }
    } else if (cloud.cloudName === "local") {
      // Local: no tunnel needed, open browser directly
      if (agent.tunnel.browserUrl) {
        const url = agent.tunnel.browserUrl(agent.tunnel.remotePort);
        if (url) {
          openBrowser(url);
        }
      }
    }
  }

  // 11c. Interactive channel login (WhatsApp QR scan, Telegram bot link)
  // Runs before the TUI so users can link messaging channels during setup.
  if (enabledSteps?.has("whatsapp")) {
    logStep("Linking WhatsApp — scan the QR code with your phone...");
    logInfo("Open WhatsApp > Settings > Linked Devices > Link a Device");
    process.stderr.write("\n");
    const whatsappCmd =
      "source ~/.spawnrc 2>/dev/null; export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH; " +
      "openclaw channels login --channel whatsapp";
    prepareStdinForHandoff();
    await cloud.interactiveSession(whatsappCmd);
  }

  // 11d. Agent-specific pre-launch tip (e.g. channel setup ordering hint)
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

  if (tunnelHandle) {
    tunnelHandle.stop();
  }
  process.exit(exitCode);
}
