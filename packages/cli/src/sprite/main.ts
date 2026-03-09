#!/usr/bin/env bun

// sprite/main.ts — Orchestrator: deploys an agent on Sprite

import type { CloudOrchestrator } from "../shared/orchestrate";

import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { agents, resolveAgent } from "./agents";
import {
  createSprite,
  ensureSpriteAuthenticated,
  ensureSpriteCli,
  getServerName,
  getVmConnection,
  interactiveSession,
  promptSpawnName,
  runSprite,
  setupShellEnvironment,
  uploadFileSprite,
  verifySpriteConnectivity,
} from "./sprite";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run sprite/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "sprite",
    cloudLabel: "Sprite",
    runner: {
      runServer: runSprite,
      uploadFile: uploadFileSprite,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureSpriteCli();
      await ensureSpriteAuthenticated();
    },
    async promptSize() {},
    async createServer(name: string) {
      await createSprite(name);
      await verifySpriteConnectivity();
      await setupShellEnvironment();
      return getVmConnection();
    },
    getServerName,
    async waitForReady() {},
    interactiveSession,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
