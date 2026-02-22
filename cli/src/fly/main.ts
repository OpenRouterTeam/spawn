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
  saveLaunchCmd,
  FLY_VM_TIERS,
  DEFAULT_VM_TIER,
} from "./fly";
import type { ServerOptions } from "./fly";
import { getOrPromptApiKey, getModelIdInteractive } from "./oauth";
import {
  resolveAgent,
  generateEnvConfig,
  offerGithubAuth,
} from "./agents";
import { logInfo, logStep, logWarn, selectFromList } from "./ui";

async function promptVmOptions(): Promise<ServerOptions> {
  // If FLY_VM_MEMORY is set, skip the interactive prompt (CI/headless mode)
  if (process.env.FLY_VM_MEMORY) {
    const memoryMb = parseInt(process.env.FLY_VM_MEMORY, 10);
    const tier = FLY_VM_TIERS.find((t) => t.memoryMb === memoryMb) || DEFAULT_VM_TIER;
    return { cpus: tier.cpus, memoryMb: tier.memoryMb };
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return { cpus: DEFAULT_VM_TIER.cpus, memoryMb: DEFAULT_VM_TIER.memoryMb };
  }

  // VM size prompt
  process.stderr.write("\n");
  const tierItems = FLY_VM_TIERS.map((t) => `${t.id}|${t.label}`);
  const tierId = await selectFromList(tierItems, "VM size", DEFAULT_VM_TIER.id);
  const selectedTier = FLY_VM_TIERS.find((t) => t.id === tierId) || DEFAULT_VM_TIER;

  return { cpus: selectedTier.cpus, memoryMb: selectedTier.memoryMb };
}

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
  const apiKey = await getOrPromptApiKey(agentName, "fly");

  // 4. Model selection (if agent needs it)
  let modelId: string | undefined;
  if (agent.modelPrompt) {
    modelId = await getModelIdInteractive(
      agent.modelDefault || "openrouter/auto",
      agent.name,
    );
  }

  // 5. VM size selection
  const serverOpts = await promptVmOptions();

  // 6. Provision server
  const serverName = await getServerName();
  await createServer(serverName, serverOpts);

  // 7. Wait for readiness
  await waitForCloudInit();

  // 8. Install agent
  await agent.install();

  // 9. Inject environment variables via .spawnrc
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

  // 10. Agent-specific configuration
  if (agent.configure) {
    try {
      await agent.configure(apiKey, modelId);
    } catch {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // 11. Pre-launch hooks (e.g. OpenClaw gateway — must succeed before TUI)
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 12. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logInfo("Fly.io machine setup completed successfully!");
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
