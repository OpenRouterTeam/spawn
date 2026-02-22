#!/usr/bin/env bun
// gcp/main.ts — Orchestrator: deploys an agent on GCP Compute Engine

import {
  ensureGcloudCli,
  authenticate,
  resolveProject,
  promptSpawnName,
  promptMachineType,
  promptZone,
  getServerName,
  createInstance,
  waitForCloudInit,
  runServer,
  interactiveSession,
  saveLaunchCmd,
} from "./gcp";
import { getOrPromptApiKey, getModelIdInteractive } from "../shared/oauth";
import {
  resolveAgent,
  generateEnvConfig,
  offerGithubAuth,
} from "./agents";
import { logInfo, logStep, logWarn } from "../shared/ui";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run gcp/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);
  logInfo(`${agent.name} on GCP Compute Engine`);
  process.stderr.write("\n");

  // 1. Authenticate with cloud provider
  await promptSpawnName();
  await ensureGcloudCli();
  await authenticate();
  await resolveProject();

  // 2. Pre-provision hooks
  if (agent.preProvision) {
    try {
      await agent.preProvision();
    } catch {
      // non-fatal
    }
  }

  // 3. Get API key (before provisioning so user isn't waiting)
  const apiKey = await getOrPromptApiKey(agentName, "gcp");

  // 4. Model selection (if agent needs it)
  let modelId: string | undefined;
  if (agent.modelPrompt) {
    modelId = await getModelIdInteractive(
      agent.modelDefault || "openrouter/auto",
      agent.name,
    );
  }

  // 5. Machine type and zone selection
  const machineType = await promptMachineType();
  const zone = await promptZone();

  // 6. Provision server
  const serverName = await getServerName();
  await createInstance(serverName, zone, machineType);

  // 7. Wait for readiness
  await waitForCloudInit();

  // 8. Install agent
  await agent.install();

  // 9. Inject environment variables via .spawnrc
  logStep("Setting up environment variables...");
  const envContent = generateEnvConfig(agent.envVars(apiKey));
  const envB64 = Buffer.from(envContent).toString("base64");
  try {
    await runServer(
      `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc; ` +
      `grep -q 'source ~/.spawnrc' ~/.bashrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.bashrc; ` +
      `grep -q 'source ~/.spawnrc' ~/.zshrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.zshrc`,
    );
  } catch {
    logWarn("Environment setup had errors");
  }

  // GitHub CLI setup
  await offerGithubAuth();

  // 10. Agent-specific configuration
  if (agent.configure) {
    try {
      await agent.configure(apiKey, modelId);
    } catch {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // 11. Pre-launch hooks (e.g. OpenClaw gateway)
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 12. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logInfo("GCP instance setup completed successfully!");
  process.stderr.write("\n");
  logStep("Starting agent...");
  await new Promise((r) => setTimeout(r, 1000));

  const launchCmd = agent.launchCmd();
  saveLaunchCmd(launchCmd);
  const exitCode = await interactiveSession(launchCmd);
  process.exit(exitCode);
}

main().catch((err) => {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  process.stderr.write(`\x1b[0;31mFatal: ${msg}\x1b[0m\n`);
  process.exit(1);
});
