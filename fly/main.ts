#!/usr/bin/env bun
// fly/main.ts — Orchestrator: deploys an agent on Fly.io

import {
  ensureFlyCli,
  ensureFlyToken,
  promptOrg,
  promptSpawnName,
  createServer,
  getServerName,
  waitForCloudInit,
  runServer,
  interactiveSession,
} from "./lib/fly";
import { getOrPromptApiKey, getModelIdInteractive } from "./lib/oauth";
import {
  resolveAgent,
  generateEnvConfig,
  offerGithubAuth,
} from "./lib/agents";
import { logInfo, logStep, logWarn } from "./lib/ui";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run fly/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);
  logInfo(`${agent.name} on Fly.io`);
  process.stderr.write("\n");

  // Apply VM memory override from agent config
  if (agent.vmMemory && !process.env.FLY_VM_MEMORY) {
    process.env.FLY_VM_MEMORY = String(agent.vmMemory);
  }

  // 1. Authenticate with cloud provider
  await promptSpawnName();
  await ensureFlyCli();
  await ensureFlyToken();
  await promptOrg();

  // 2. Pre-provision hooks
  if (agent.preProvision) {
    try {
      await agent.preProvision();
    } catch {
      // non-fatal
    }
  }

  // 3. Get API key (before provisioning so user isn't waiting)
  const apiKey = await getOrPromptApiKey();

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
  // Inline base64 write + shell hook in a single remote call instead of
  // separate uploadFile + mv + 2× shell hook calls.
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

  // 10. Pre-launch hooks
  if (agent.preLaunch) {
    try {
      await agent.preLaunch();
    } catch {
      logWarn("Pre-launch hook failed (continuing)");
    }
  }

  // 11. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logInfo("Fly.io machine setup completed successfully!");
  process.stderr.write("\n");
  logStep("Starting agent...");
  await new Promise((r) => setTimeout(r, 1000));

  const exitCode = await interactiveSession(agent.launchCmd());
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
