#!/usr/bin/env bun
// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import {
  ensureHcloudToken,
  ensureSshKey,
  promptSpawnName,
  createServer,
  getServerName,
  waitForCloudInit,
  runServer,
  interactiveSession,
  saveLaunchCmd,
} from "./hetzner";
import { getOrPromptApiKey, getModelIdInteractive } from "../fly/oauth";
import {
  resolveAgent,
  generateEnvConfig,
  offerGithubAuth,
} from "./agents";
import { logInfo, logStep, logWarn } from "../fly/ui";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run hetzner/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);
  logInfo(`${agent.name} on Hetzner Cloud`);
  process.stderr.write("\n");

  // 1. Authenticate with cloud provider
  await promptSpawnName();
  await ensureHcloudToken();
  await ensureSshKey();

  // 2. Pre-provision hooks
  if (agent.preProvision) {
    try {
      await agent.preProvision();
    } catch {
      // non-fatal
    }
  }

  // 3. Get API key (before provisioning so user isn't waiting)
  const apiKey = await getOrPromptApiKey(agentName, "hetzner");

  // 4. Model selection (if agent needs it)
  let modelId: string | undefined;
  if (agent.modelPrompt) {
    modelId = await getModelIdInteractive(
      agent.modelDefault || "openrouter/auto",
      agent.name,
    );
  }

  // 5. Provision server
  const serverName = await getServerName();
  await createServer(serverName);

  // 6. Wait for readiness
  await waitForCloudInit();

  // 7. Install agent
  await agent.install();

  // 8. Inject environment variables via .spawnrc
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

  // 9. Agent-specific configuration
  if (agent.configure) {
    try {
      await agent.configure(apiKey, modelId);
    } catch {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // 10. Pre-launch hooks (e.g. OpenClaw gateway)
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 11. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logInfo("Hetzner Cloud server setup completed successfully!");
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
