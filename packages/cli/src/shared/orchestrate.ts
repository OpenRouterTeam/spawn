// shared/orchestrate.ts — Shared orchestration pipeline for deploying agents
// Each cloud implements CloudOrchestrator and calls runOrchestration().

import type { SpawnRecord, VMConnection } from "../history.js";
import type { CloudRunner } from "./agent-setup.js";
import type { AgentConfig } from "./agents.js";
import type { SshTunnelHandle } from "./ssh.js";

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { getErrorMessage } from "@openrouter/spawn-shared";
import * as v from "valibot";
import {
  generateSpawnId,
  mergeChildHistory,
  SpawnRecordSchema,
  saveLaunchCmd,
  saveMetadata,
  saveSpawnRecord,
} from "../history.js";
import { offerGithubAuth, setupAutoUpdate, setupSecurityScan, wrapSshCall } from "./agent-setup.js";
import { tryTarballInstall } from "./agent-tarball.js";
import { generateEnvConfig } from "./agents.js";
import { getOrPromptApiKey } from "./oauth.js";
import { parseJsonWith } from "./parse.js";
import { getSpawnCloudConfigPath, getSpawnPreferencesPath, getTmpDir } from "./paths.js";
import { asyncTryCatch, asyncTryCatchIf, isOperationalError, tryCatch } from "./result.js";
import { isWindows } from "./shell.js";
import { injectSpawnSkill } from "./spawn-skill.js";
import { sleep, startSshTunnel } from "./ssh.js";
import { ensureSshKeys, getSshKeyOpts } from "./ssh-keys.js";
import {
  logDebug,
  logError,
  logInfo,
  logStep,
  logWarn,
  openBrowser,
  prepareStdinForHandoff,
  prompt,
  retryOrQuit,
  shellQuote,
  validateModelId,
  withRetry,
} from "./ui.js";

/** Docker container name used by --beta docker deployments. */
export const DOCKER_CONTAINER_NAME = "spawn-agent";
/** Docker registry hosting spawn agent images. */
export const DOCKER_REGISTRY = "ghcr.io/openrouterteam";

/** Wrap a command to run inside the Docker container instead of the host. */
function makeDockerExec(cmd: string): string {
  if (!cmd || cmd.length === 0) {
    throw new Error("makeDockerExec: command must be non-empty");
  }
  return `docker exec ${DOCKER_CONTAINER_NAME} bash -c ${shellQuote(cmd)}`;
}

/** Wrap a CloudRunner so all commands and uploads target the Docker container. */
export function makeDockerRunner(hostRunner: CloudRunner): CloudRunner {
  return {
    runServer: (cmd: string, timeoutSecs?: number) => hostRunner.runServer(makeDockerExec(cmd), timeoutSecs),
    uploadFile: async (localPath: string, remotePath: string) => {
      await hostRunner.uploadFile(localPath, remotePath);
      await hostRunner.runServer(
        `docker cp ${shellQuote(remotePath)} ${DOCKER_CONTAINER_NAME}:${shellQuote(remotePath)}`,
      );
    },
    downloadFile: hostRunner.downloadFile,
  };
}

export interface CloudOrchestrator {
  cloudName: string;
  cloudLabel: string;
  runner: CloudRunner;
  /** When true, skip tarball + agent install (e.g. booting from a pre-baked snapshot). */
  skipAgentInstall?: boolean;
  /** When true, skip cloud-init wait — just wait for SSH (e.g. minimal-tier agent with tarball). */
  skipCloudInit?: boolean;
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
  /** Return a browser URL for signed-preview style dashboard access. */
  getSignedPreviewUrl?(remotePort: number, urlSuffix?: string, expiresInSeconds?: number): Promise<string>;
  /** Install a provider-native auto-update mechanism when the shared systemd timer does not apply. */
  setupAutoUpdate?(agentName: string, updateCmd: string): Promise<void>;
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

// ── Recursive spawn helpers ──────────────────────────────────────────────────

/** Install the spawn CLI on a remote VM. */
export async function installSpawnCli(runner: CloudRunner): Promise<void> {
  logStep("Installing spawn CLI on VM...");
  // Build PATH explicitly — non-interactive bash skips .bashrc (PS1 guard),
  // and some platforms (Sprite) have a broken bun shim that finds via
  // `command -v` but doesn't actually work. We prepend all known bun
  // locations so the real binary is found first, then test `bun --version`
  // (not just existence) and install bun fresh if it doesn't work.
  const installCmd = [
    'export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"',
    'export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/.sprite/languages/bun/bin:/usr/local/bin:$PATH"',
    'if ! bun --version >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"; fi',
    "curl -fsSL https://openrouter.ai/labs/spawn/cli/install.sh | bash",
  ].join("; ");
  const result = await asyncTryCatch(() =>
    withRetry("spawn CLI install", () => wrapSshCall(runner.runServer(installCmd)), 2, 5),
  );
  if (!result.ok) {
    logWarn("Spawn CLI install failed — recursive spawning will not be available on this VM");
  } else {
    logInfo("Spawn CLI installed on VM");
  }
}

/** Copy local cloud credentials to the remote VM for recursive spawning. */
export async function delegateCloudCredentials(runner: CloudRunner): Promise<void> {
  logStep("Delegating cloud credentials to VM...");

  const filesToDelegate: {
    localPath: string;
    remotePath: string;
  }[] = [];

  // Delegate ALL cloud credentials so the child VM can spawn on any cloud,
  // not just the one the parent is running on.
  const cloudNames = [
    "hetzner",
    "digitalocean",
    "aws",
    "gcp",
    "sprite",
  ];
  for (const cloud of cloudNames) {
    const cloudConfigPath = getSpawnCloudConfigPath(cloud);
    if (existsSync(cloudConfigPath)) {
      filesToDelegate.push({
        localPath: cloudConfigPath,
        remotePath: `~/.config/spawn/${cloud}.json`,
      });
    }
  }

  // OpenRouter credentials (always needed for child spawns)
  const orConfigPath = getSpawnCloudConfigPath("openrouter");
  if (existsSync(orConfigPath)) {
    filesToDelegate.push({
      localPath: orConfigPath,
      remotePath: "~/.config/spawn/openrouter.json",
    });
  }

  if (filesToDelegate.length === 0) {
    logWarn("No credentials to delegate — child spawns may require manual auth");
    return;
  }

  // Ensure config dir exists on VM
  const mkdirResult = await asyncTryCatch(() =>
    runner.runServer("mkdir -p ~/.config/spawn && chmod 700 ~/.config/spawn"),
  );
  if (!mkdirResult.ok) {
    logWarn("Could not create config directory on VM");
    return;
  }

  for (const file of filesToDelegate) {
    const content = readFileSync(file.localPath, "utf-8");
    const b64 = Buffer.from(content).toString("base64");
    if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
      throw new Error("Unexpected characters in base64 output");
    }
    const writeResult = await asyncTryCatch(() =>
      runner.runServer(`printf '%s' '${b64}' | base64 -d > ${file.remotePath} && chmod 600 ${file.remotePath}`),
    );
    if (!writeResult.ok) {
      logWarn(`Could not delegate ${file.remotePath}`);
    }
  }

  logInfo("Cloud credentials delegated to VM");
}

/** Get parent_id and depth fields for spawn records (set when running inside a child VM). */
function getParentFields(): {
  parent_id?: string;
  depth?: number;
} {
  const parentId = process.env.SPAWN_PARENT_ID;
  const depth = Number(process.env.SPAWN_DEPTH) || 0;
  return parentId
    ? {
        parent_id: parentId,
        depth,
      }
    : depth > 0
      ? {
          depth,
        }
      : {};
}

/** Build and persist a SpawnRecord for a newly-created server. */
function recordSpawn(spawnId: string, agentName: string, cloudName: string, connection: VMConnection): void {
  const spawnName = process.env.SPAWN_NAME_KEBAB || process.env.SPAWN_NAME || undefined;
  saveSpawnRecord({
    id: spawnId,
    agent: agentName,
    cloud: cloudName,
    timestamp: new Date().toISOString(),
    ...(spawnName
      ? {
          name: spawnName,
        }
      : {}),
    ...getParentFields(),
    connection,
  });
}

/** Append recursive-spawn env vars to the envPairs array when --beta recursive is active. */
export function appendRecursiveEnvVars(envPairs: string[], spawnId: string): void {
  const currentDepth = Number(process.env.SPAWN_DEPTH) || 0;
  envPairs.push(`SPAWN_PARENT_ID=${spawnId}`);
  envPairs.push(`SPAWN_DEPTH=${currentDepth + 1}`);
  envPairs.push("SPAWN_BETA=recursive");
}

/** Options for runOrchestration (used in tests to inject mock dependencies). */
export interface OrchestrationOptions {
  tryTarball?: (runner: CloudRunner, agentName: string) => Promise<boolean>;
  getApiKey?: (agentSlug?: string, cloudSlug?: string) => Promise<string>;
}

/**
 * Load a preferred model from ~/.config/spawn/preferences.json.
 * Format: { "models": { "codex": "openai/gpt-5.3-codex", "openclaw": "anthropic/claude-sonnet-4.6" } }
 * Returns null if no preference is set or the file doesn't exist.
 */
const PreferencesSchema = v.object({
  models: v.optional(v.record(v.string(), v.string())),
  starPromptShownAt: v.optional(v.string()),
});

function loadPreferredModel(agentName: string): string | null {
  const result = tryCatch(() => {
    const raw = JSON.parse(readFileSync(getSpawnPreferencesPath(), "utf-8"));
    const parsed = v.safeParse(PreferencesSchema, raw);
    if (!parsed.success) {
      return null;
    }
    return parsed.output.models?.[agentName] ?? null;
  });
  return result.ok ? result.data : null;
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

  const betaFeatures = new Set((process.env.SPAWN_BETA ?? "").split(",").filter(Boolean));
  const fastMode = process.env.SPAWN_FAST === "1" || betaFeatures.has("parallel");
  const useTarball = fastMode || betaFeatures.has("tarball");

  // Skip cloud-init for minimal-tier agents when using tarballs or snapshots.
  // Ubuntu 24.04 base images already have curl + git, so minimal agents (claude,
  // opencode, hermes) don't need the cloud-init package install step.
  // This saves ~30-60s by just waiting for SSH instead of polling for cloud-init completion.
  if (
    cloud.cloudName !== "local" &&
    (useTarball || cloud.skipAgentInstall) &&
    (agent.cloudInitTier === "minimal" || !agent.cloudInitTier)
  ) {
    cloud.skipCloudInit = true;
  }

  // 1b. Size/bundle selection (must happen before createServer)
  await cloud.promptSize();

  // 2. Provision server
  const spawnId = generateSpawnId();
  const serverName = await cloud.getServerName();

  if (fastMode && cloud.cloudName !== "local") {
    // ── Fast mode: server boot + setup prompts run concurrently ─────────
    // Start server creation, then do API key prompt, pre-provision, tarball
    // download, and account check in parallel with server boot.
    //
    // Keep a dummy timer on the event loop so Bun doesn't exit prematurely.
    // When all concurrent promises settle (especially after Bun.serve.stop()
    // in the OAuth flow removes its handle), the event loop can appear empty
    // before the continuation starts new I/O — causing a silent exit(0).
    const keepAlive = setInterval(() => {}, 60_000);

    const serverBootPromise = (async () => {
      const conn = await cloud.createServer(serverName);
      recordSpawn(spawnId, agentName, cloud.cloudName, conn);
      await cloud.waitForReady();
      return conn;
    })();

    const resolveApiKey = options?.getApiKey ?? getOrPromptApiKey;

    // These all run concurrently with server boot
    const [bootResult, apiKeyResult] = await Promise.allSettled([
      serverBootPromise,
      resolveApiKey(agentName, cloud.cloudName),
      cloud.checkAccountReady
        ? asyncTryCatch(() => cloud.checkAccountReady!())
        : Promise.resolve({
            ok: true,
          }),
      agent.preProvision
        ? asyncTryCatch(() => agent.preProvision!())
        : Promise.resolve({
            ok: true,
          }),
    ]);

    // Server boot must succeed — retry if it failed
    if (bootResult.status === "rejected") {
      logError(getErrorMessage(bootResult.reason));
      await retryOrQuit("Retry server creation?");
      // User chose to retry — fall through to sequential path which has full retry loops
      // (Re-running the concurrent path would re-prompt for API key, etc.)
      const connection = await cloud.createServer(serverName);
      recordSpawn(spawnId, agentName, cloud.cloudName, connection);
      await cloud.waitForReady();
    }

    // API key must succeed
    if (apiKeyResult.status === "rejected") {
      throw apiKeyResult.reason;
    }
    const apiKey = apiKeyResult.value;

    // Model ID
    const rawModelId = process.env.MODEL_ID || loadPreferredModel(agentName) || agent.modelDefault;
    const modelId = rawModelId && validateModelId(rawModelId) ? rawModelId : undefined;
    if (rawModelId && !modelId) {
      logWarn(`Ignoring invalid MODEL_ID: ${rawModelId}`);
    }

    // Env config (computed locally, no SSH needed)
    const envPairs = agent.envVars(apiKey);
    if (modelId && agent.modelEnvVar) {
      envPairs.push(`${agent.modelEnvVar}=${modelId}`);
    }
    if (betaFeatures.has("recursive")) {
      appendRecursiveEnvVars(envPairs, spawnId);
    }
    const envContent = generateEnvConfig(envPairs);

    // Install agent — remote tarball, fallback to live install
    if (cloud.skipAgentInstall) {
      logInfo("Snapshot boot — skipping agent install");
    } else {
      let installed = false;
      if (useTarball && !agent.skipTarball) {
        const tarball = options?.tryTarball ?? tryTarballInstall;
        installed = await tarball(cloud.runner, agentName);
      }
      if (!installed) {
        for (;;) {
          const r = await asyncTryCatch(() => agent.install());
          if (r.ok) {
            break;
          }
          logError(getErrorMessage(r.error));
          await retryOrQuit("Retry agent install?");
        }
      }
    }

    // Inject env + continue with shared post-install flow
    clearInterval(keepAlive);
    await injectEnvVars(cloud, envContent);
    await postInstall(cloud, agent, agentName, apiKey, modelId, spawnId, options);
  } else {
    // ── Standard sequential flow ────────────────────────────────────────

    // 1b. Pre-flight account readiness check
    if (cloud.checkAccountReady) {
      const r = await asyncTryCatch(() => cloud.checkAccountReady!());
      if (!r.ok) {
        logWarn("Account readiness check failed — proceeding anyway");
        logDebug(getErrorMessage(r.error));
      }
    }

    // 2. Get API key
    const resolveApiKey = options?.getApiKey ?? getOrPromptApiKey;
    const apiKey = await resolveApiKey(agentName, cloud.cloudName);

    // 3. Pre-provision hooks
    if (agent.preProvision) {
      const r = await asyncTryCatch(() => agent.preProvision!());
      if (!r.ok) {
        logWarn("Pre-provision hook failed — continuing");
        logDebug(getErrorMessage(r.error));
      }
    }

    // 4. Model ID
    const rawModelId = process.env.MODEL_ID || loadPreferredModel(agentName) || agent.modelDefault;
    const modelId = rawModelId && validateModelId(rawModelId) ? rawModelId : undefined;
    if (rawModelId && !modelId) {
      logWarn(`Ignoring invalid MODEL_ID: ${rawModelId}`);
    }

    // 5. Provision server (retry loop)
    let connection: VMConnection;
    for (;;) {
      const r = await asyncTryCatch(() => cloud.createServer(serverName));
      if (r.ok) {
        connection = r.data;
        break;
      }
      logError(getErrorMessage(r.error));
      await retryOrQuit("Retry server creation?");
    }
    recordSpawn(spawnId, agentName, cloud.cloudName, connection);

    // 6. Wait for readiness (retry loop)
    for (;;) {
      const r = await asyncTryCatch(() => cloud.waitForReady());
      if (r.ok) {
        break;
      }
      logError(getErrorMessage(r.error));
      await retryOrQuit("Server may still be starting. Keep waiting?");
    }

    // 7. Env config
    const envPairs = agent.envVars(apiKey);
    if (modelId && agent.modelEnvVar) {
      envPairs.push(`${agent.modelEnvVar}=${modelId}`);
    }
    if (betaFeatures.has("recursive")) {
      appendRecursiveEnvVars(envPairs, spawnId);
    }
    const envContent = generateEnvConfig(envPairs);

    // 8. Install agent
    if (cloud.skipAgentInstall) {
      logInfo("Snapshot boot — skipping agent install");
    } else {
      let installedFromTarball = false;
      if (cloud.cloudName !== "local" && !agent.skipTarball && useTarball) {
        const tarball = options?.tryTarball ?? tryTarballInstall;
        installedFromTarball = await tarball(cloud.runner, agentName);
      }
      if (!installedFromTarball) {
        for (;;) {
          const r = await asyncTryCatch(() => agent.install());
          if (r.ok) {
            break;
          }
          logError(getErrorMessage(r.error));
          await retryOrQuit("Retry agent install?");
        }
      }
    }

    // Inject env + continue with shared post-install flow
    await injectEnvVars(cloud, envContent);
    await postInstall(cloud, agent, agentName, apiKey, modelId, spawnId, options);
  }
}

/** Write env content to ~/.spawnrc and ensure all shell rc files source it. */
export async function injectEnvVarsToRunner(runner: CloudRunner, envContent: string): Promise<void> {
  logStep("Setting up environment variables...");
  const envB64 = Buffer.from(envContent).toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(envB64)) {
    throw new Error("Unexpected characters in base64 output");
  }

  const envSetupCmd =
    `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc; ` +
    "for _rc in ~/.bashrc ~/.profile ~/.bash_profile ~/.zshrc; do " +
    `grep -q 'source ~/.spawnrc' "$_rc" 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> "$_rc"; ` +
    "done";

  const envResult = await asyncTryCatch(() =>
    withRetry("env setup", () => wrapSshCall(runner.runServer(envSetupCmd)), 2, 5),
  );
  if (!envResult.ok) {
    logWarn("Environment setup had errors");
  }
}

async function injectEnvVars(cloud: CloudOrchestrator, envContent: string): Promise<void> {
  const isLocalWindows = cloud.cloudName === "local" && isWindows();
  if (isLocalWindows) {
    logStep("Setting up environment variables...");
    const envB64 = Buffer.from(envContent).toString("base64");
    if (!/^[A-Za-z0-9+/=]+$/.test(envB64)) {
      throw new Error("Unexpected characters in base64 output");
    }
    const envSetupCmd =
      `$bytes = [Convert]::FromBase64String('${envB64}'); ` + `[IO.File]::WriteAllBytes("$HOME/.spawnrc", $bytes)`;
    const envResult = await asyncTryCatch(() =>
      withRetry("env setup", () => wrapSshCall(cloud.runner.runServer(envSetupCmd)), 2, 5),
    );
    if (!envResult.ok) {
      logWarn("Environment setup had errors");
    }
    return;
  }
  await injectEnvVarsToRunner(cloud.runner, envContent);
}

async function postInstall(
  cloud: CloudOrchestrator,
  agent: AgentConfig,
  agentName: string,
  apiKey: string,
  modelId: string | undefined,
  spawnId: string,
  _options?: OrchestrationOptions,
): Promise<void> {
  // Parse enabled setup steps
  let enabledSteps: Set<string> | undefined;
  const stepsEnv = process.env.SPAWN_ENABLED_STEPS;
  const isHeadless = process.env.SPAWN_HEADLESS === "1";
  if (stepsEnv !== undefined) {
    const stepNames = stepsEnv.split(",").filter(Boolean);
    if (stepNames.length > 0) {
      const { validateStepNames } = await import("./agents.js");
      const { valid, invalid } = validateStepNames(agentName, stepNames);
      if (invalid.length > 0) {
        logWarn(`Unknown setup steps ignored: ${invalid.join(", ")}`);
      }
      enabledSteps = new Set(valid);
    } else {
      enabledSteps = new Set();
    }
  } else if (isHeadless) {
    // In headless mode, default to auto-update only (use --steps all to override)
    enabledSteps = new Set([
      "auto-update",
    ]);
  }

  // Agent-specific configuration
  if (agent.configure) {
    const configResult = await asyncTryCatch(() =>
      withRetry("agent config", () => wrapSshCall(agent.configure!(apiKey, modelId, enabledSteps)), 2, 5),
    );
    if (!configResult.ok) {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // GitHub CLI setup
  if (!enabledSteps || enabledSteps.has("github")) {
    await offerGithubAuth(cloud.runner, enabledSteps?.has("github"));
  }

  // Auto-update service
  if (cloud.cloudName !== "local" && agent.updateCmd && (!enabledSteps || enabledSteps.has("auto-update"))) {
    if (cloud.cloudName === "daytona") {
      // Daytona reconnects need to know whether they should recreate the provider-native
      // background updater after a sandbox stop/start cycle.
      saveMetadata(
        {
          auto_update_enabled: "1",
        },
        spawnId,
      );
    }
    if (cloud.setupAutoUpdate) {
      await cloud.setupAutoUpdate(agentName, agent.updateCmd);
    } else {
      await setupAutoUpdate(cloud.runner, agentName, agent.updateCmd);
    }
  } else if (cloud.cloudName === "daytona" && agent.updateCmd) {
    // Persist the disabled state too so reconnect paths can distinguish "not configured"
    // from "configured earlier but the sandbox session was lost".
    saveMetadata(
      {
        auto_update_enabled: "0",
      },
      spawnId,
    );
  }

  // Security scan cron
  if (
    cloud.cloudName !== "local" &&
    cloud.cloudName !== "daytona" &&
    (!enabledSteps || enabledSteps.has("security-scan"))
  ) {
    await setupSecurityScan(cloud.runner);
  }

  // Spawn CLI + skill injection (recursive spawn)
  // The "spawn" step is defaultOn when --beta recursive is active, so it should
  // run when no explicit steps are selected (!enabledSteps) AND the beta flag is set.
  const betaFeaturesPost = new Set((process.env.SPAWN_BETA ?? "").split(",").filter(Boolean));
  if (
    cloud.cloudName !== "local" &&
    betaFeaturesPost.has("recursive") &&
    (!enabledSteps || enabledSteps.has("spawn"))
  ) {
    await installSpawnCli(cloud.runner);
    await delegateCloudCredentials(cloud.runner);
    await injectSpawnSkill(cloud.runner, agentName);
  }

  // Skill installation (--beta skills)
  const selectedSkillsEnv = process.env.SPAWN_SELECTED_SKILLS;
  if (selectedSkillsEnv && cloud.cloudName !== "local") {
    const skillIds = selectedSkillsEnv.split(",").filter(Boolean);
    if (skillIds.length > 0) {
      const { loadManifest } = await import("../manifest.js");
      const manifestForSkills = await loadManifest();
      if (manifestForSkills.skills) {
        const { installSkills } = await import("./skills.js");
        await installSkills(cloud.runner, manifestForSkills, agentName, skillIds);

        // Append skill env vars to .spawnrc so MCP servers can resolve ${VAR} at runtime
        const skillEnvPairs = (process.env.SPAWN_SKILL_ENV_PAIRS ?? "").split(",").filter(Boolean);
        if (skillEnvPairs.length > 0) {
          const envLines = skillEnvPairs
            .map((pair) => {
              const eqIdx = pair.indexOf("=");
              if (eqIdx === -1) {
                return "";
              }
              const key = pair.slice(0, eqIdx);
              const val = pair.slice(eqIdx + 1);
              return `export ${key}='${val.replace(/'/g, "'\\''")}'`;
            })
            .filter(Boolean)
            .join("\n");
          if (envLines) {
            await asyncTryCatch(() =>
              cloud.runner.runServer(`printf '\\n# [spawn:skills]\\n${envLines}\\n' >> ~/.spawnrc`),
            );
          }
        }
      }
    }
  }

  // Pre-launch hooks (retry loop)
  if (agent.preLaunch) {
    for (;;) {
      const r = await asyncTryCatch(() => agent.preLaunch!());
      if (r.ok) {
        break;
      }
      logError(getErrorMessage(r.error));
      await retryOrQuit("Retry pre-launch setup?");
    }
  }

  // Web dashboard access
  let tunnelHandle: SshTunnelHandle | undefined;
  if (agent.tunnel) {
    const tunnelCfg = agent.tunnel; // capture for closure (TS can't narrow across async boundaries)
    const templateUrl = tunnelCfg.browserUrl?.(0);

    if (cloud.getConnectionInfo) {
      const getConnInfo = cloud.getConnectionInfo; // capture for closure
      const tunnelResult = await asyncTryCatchIf(isOperationalError, async () => {
        const conn = getConnInfo();
        const keys = await ensureSshKeys();
        tunnelHandle = await startSshTunnel({
          host: conn.host,
          user: conn.user,
          remotePort: tunnelCfg.remotePort,
          sshKeyOpts: getSshKeyOpts(keys),
        });
        if (tunnelCfg.browserUrl) {
          const url = tunnelCfg.browserUrl(tunnelHandle.localPort);
          if (url) {
            openBrowser(url);
          }
        }
      });
      if (!tunnelResult.ok) {
        logWarn("Web dashboard tunnel failed — use the TUI instead");
      }
    } else if (cloud.getSignedPreviewUrl) {
      const previewResult = await asyncTryCatchIf(isOperationalError, async () => {
        const urlSuffix = templateUrl ? templateUrl.replace("http://localhost:0", "") : undefined;
        const url = await cloud.getSignedPreviewUrl!(tunnelCfg.remotePort, urlSuffix, 3600);
        openBrowser(url);
      });
      if (!previewResult.ok) {
        logWarn("Web dashboard preview failed — use the TUI instead");
      }
    } else if (cloud.cloudName === "local") {
      if (agent.tunnel.browserUrl) {
        const url = agent.tunnel.browserUrl(agent.tunnel.remotePort);
        if (url) {
          openBrowser(url);
        }
      }
    }

    const tunnelMeta: Record<string, string> = {
      tunnel_remote_port: String(agent.tunnel.remotePort),
    };
    if (templateUrl) {
      tunnelMeta.tunnel_browser_url_template = templateUrl.replace("localhost:0", "localhost:__PORT__");
    }
    saveMetadata(tunnelMeta, spawnId);
  }

  // Channel setup
  const ocPath = "export PATH=$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH";

  if (enabledSteps?.has("telegram")) {
    logStep("Telegram pairing...");
    logInfo("To pair your Telegram account:");
    logInfo("  1. Open Telegram on your phone");
    logInfo("  2. Search for the bot you created with @BotFather");
    logInfo('  3. Send it any message (e.g. "hello")');
    logInfo("  4. The bot will reply with a pairing code");
    logInfo("  5. Enter the code below");
    process.stderr.write("\n");
    const pairingCode = (await prompt("Telegram pairing code: ")).trim();
    if (pairingCode) {
      const escaped = shellQuote(pairingCode);
      const result = await asyncTryCatchIf(isOperationalError, () =>
        cloud.runner.runServer(
          `source ~/.spawnrc 2>/dev/null; ${ocPath}; openclaw pairing approve telegram ${escaped}`,
        ),
      );
      if (result.ok) {
        logInfo("Telegram paired successfully");
      } else {
        logWarn("Pairing failed — you can pair later via: openclaw pairing approve telegram <CODE>");
      }
    } else {
      logInfo("No code entered — pair later via: openclaw pairing approve telegram <CODE>");
    }
  }

  if (agent.preLaunchMsg) {
    process.stderr.write("\n");
    logInfo(`Tip: ${agent.preLaunchMsg}`);
  }

  // Launch agent
  logInfo(`Agent setup complete — ${agent.name} is ready on ${cloud.cloudLabel}`);
  process.stderr.write("\n");

  const launchCmd = agent.launchCmd();
  saveLaunchCmd(launchCmd, spawnId);

  // In headless mode, provisioning is done — skip the interactive session.
  // If --prompt was provided and the agent has a promptCmd, execute the prompt on the VM.
  if (isHeadless) {
    const headlessPrompt = process.env.SPAWN_PROMPT;
    if (headlessPrompt && agent.promptCmd) {
      logInfo("Headless mode — running prompt on provisioned VM...");
      const promptRunCmd = agent.promptCmd(headlessPrompt);
      const promptResult = await asyncTryCatch(() => cloud.runner.runServer(promptRunCmd, 600));
      if (!promptResult.ok) {
        logWarn(`Prompt execution failed: ${getErrorMessage(promptResult.error)}`);
      } else {
        logInfo("Prompt execution completed");
      }
    } else {
      logInfo("Headless mode — provisioning complete. Skipping interactive session.");
    }
    if (tunnelHandle) {
      tunnelHandle.stop();
    }
    if (cloud.cloudName !== "local") {
      await pullChildHistory(cloud.runner, spawnId);
    }
    process.exit(0);
  }

  logStep("Provisioning complete. Connecting to agent session...");

  // Reset terminal state before handing off to the interactive SSH session.
  // @clack/prompts may have left the cursor hidden or set ANSI attributes
  // (e.g. color, bold) that would corrupt the remote agent's TUI rendering.
  if (process.stderr.isTTY) {
    process.stderr.write("\x1b[?25h\x1b[0m");
  }

  prepareStdinForHandoff();

  const sessionCmd = cloud.cloudName === "local" ? launchCmd : wrapWithRestartLoop(launchCmd);

  // Auto-reconnect on connection drops. Ctrl+C (exit 0 or 130) exits immediately.
  // Only applies to remote clouds — local sessions don't have connection drops.
  // SSH exits 255 on connection loss; Sprite CLI exits 1 on "connection closed".
  const maxReconnects = cloud.cloudName === "local" ? 0 : 5;
  const isConnectionDrop = (code: number): boolean => code === 255 || (cloud.cloudName === "sprite" && code === 1);
  let exitCode = 0;

  for (let attempt = 0; attempt <= maxReconnects; attempt++) {
    if (attempt > 0) {
      process.stderr.write("\n");
      logWarn(`Connection lost. Reconnecting... (${attempt}/${maxReconnects})`);
      await sleep(3000);
      prepareStdinForHandoff();
    }
    exitCode = await cloud.interactiveSession(sessionCmd);

    if (!isConnectionDrop(exitCode)) {
      break;
    }
  }

  if (isConnectionDrop(exitCode)) {
    process.stderr.write("\n");
    logWarn("Could not reconnect. Server is still running.");
    logInfo("Reconnect manually: spawn connect");
  }

  if (tunnelHandle) {
    tunnelHandle.stop();
  }

  // Pull child's spawn history back to the parent for `spawn tree`.
  // Fire-and-forget — never delay exit for a convenience feature.
  // process.exit() below kills any in-flight SSH calls.
  if (cloud.cloudName !== "local") {
    pullChildHistory(cloud.runner, spawnId).catch(() => {});
  }

  process.exit(exitCode);
}

/**
 * Pull spawn history from a child VM and merge it into local history.
 * First tells the child to recursively pull from ITS children via
 * `spawn pull-history`, then downloads the child's history.json.
 * This enables `spawn tree` to show the full recursive hierarchy.
 */
async function pullChildHistory(runner: CloudRunner, parentSpawnId: string): Promise<void> {
  const result = await asyncTryCatch(async () => {
    const tmpPath = `${getTmpDir()}/child-history-${parentSpawnId}.json`;

    // Recursive pull: tell the child to pull from ALL its children first.
    const recursePull = await asyncTryCatch(() =>
      runner.runServer(
        'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; spawn pull-history 2>/dev/null || true',
        120,
      ),
    );
    if (!recursePull.ok) {
      logDebug("Recursive history pull skipped");
    }

    // Copy the child's history to a temp location then download
    const copyResult = await asyncTryCatch(() =>
      runner.runServer(
        "cp ~/.spawn/history.json /tmp/_spawn_history.json 2>/dev/null || cp ~/.config/spawn/history.json /tmp/_spawn_history.json 2>/dev/null || echo '{}'  > /tmp/_spawn_history.json",
      ),
    );
    if (!copyResult.ok) {
      return;
    }

    await runner.downloadFile("/tmp/_spawn_history.json", tmpPath);

    const json = readFileSync(tmpPath, "utf-8");
    const ChildHistorySchema = v.object({
      version: v.optional(v.number()),
      records: v.array(SpawnRecordSchema),
    });
    const parsed = parseJsonWith(json, ChildHistorySchema);
    if (!parsed || parsed.records.length === 0) {
      return;
    }

    const validRecords: SpawnRecord[] = [];
    for (const r of parsed.records) {
      if (r.id) {
        validRecords.push({
          id: r.id,
          agent: r.agent,
          cloud: r.cloud,
          timestamp: r.timestamp,
          ...(r.name
            ? {
                name: r.name,
              }
            : {}),
          ...(r.parent_id
            ? {
                parent_id: r.parent_id,
              }
            : {}),
          ...(r.depth !== undefined
            ? {
                depth: r.depth,
              }
            : {}),
          ...(r.connection
            ? {
                connection: r.connection,
              }
            : {}),
        });
      }
    }

    if (validRecords.length > 0) {
      mergeChildHistory(parentSpawnId, validRecords);
      logInfo(`Pulled ${validRecords.length} spawn record(s) from child VM`);
    }

    tryCatch(() => unlinkSync(tmpPath));
  });

  if (!result.ok) {
    logDebug(`Could not pull child history: ${getErrorMessage(result.error)}`);
  }
}
