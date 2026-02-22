#!/usr/bin/env bun
// local/main.ts — Orchestrator: deploys an agent on the local machine

import { getOrPromptApiKey, getModelIdInteractive } from "../shared/oauth";
import { resolveAgent, generateEnvConfig } from "./agents";
import { runLocal, interactiveSession, saveLocalConnection, saveLaunchCmd } from "./local";
import { logInfo, logStep, logWarn } from "../shared/ui";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run local/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);
  logInfo(`${agent.name} on local machine`);
  process.stderr.write("\n");

  // 1. Save connection info
  saveLocalConnection();

  // 2. Get API key
  const apiKey = await getOrPromptApiKey(agentName, "local");

  // 3. Model selection (if agent needs it)
  let modelId: string | undefined;
  if (agent.modelPrompt) {
    modelId = await getModelIdInteractive(
      agent.modelDefault || "openrouter/auto",
      agent.name,
    );
  }

  // 4. Install agent
  await agent.install();

  // 5. Inject environment variables via .spawnrc
  logStep("Setting up environment variables...");
  const envContent = generateEnvConfig(agent.envVars(apiKey));
  const envB64 = Buffer.from(envContent).toString("base64");
  try {
    await runLocal(
      `printf '%s' '${envB64}' | base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc; ` +
      `grep -q 'source ~/.spawnrc' ~/.bashrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.bashrc; ` +
      `grep -q 'source ~/.spawnrc' ~/.zshrc 2>/dev/null || echo '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> ~/.zshrc`,
    );
  } catch {
    logWarn("Environment setup had errors");
  }

  // 6. Agent-specific configuration
  if (agent.configure) {
    try {
      await agent.configure(apiKey, modelId);
    } catch {
      logWarn("Agent configuration failed (continuing with defaults)");
    }
  }

  // 7. Pre-launch hooks
  if (agent.preLaunch) {
    await agent.preLaunch();
  }

  // 8. Launch interactive session
  logInfo(`${agent.name} is ready`);
  process.stderr.write("\n");
  logStep("Starting agent...");
  await new Promise((r) => setTimeout(r, 500));

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
