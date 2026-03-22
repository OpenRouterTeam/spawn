#!/usr/bin/env bun

// sprite/main.ts — Orchestrator: deploys an agent on Sprite

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate.js";
import { agents, resolveAgent } from "./agents.js";
import {
  createSprite,
  downloadFileSprite,
  ensureSpriteAuthenticated,
  ensureSpriteCli,
  getServerName,
  getVmConnection,
  installSpriteKeepAlive,
  interactiveSession,
  promptSpawnName,
  runSprite,
  setupShellEnvironment,
  startLocalKeepAlive,
  stopLocalKeepAlive,
  uploadFileSprite,
  verifySpriteConnectivity,
} from "./sprite.js";

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
      downloadFile: downloadFileSprite,
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
      // Start pinging the sprite URL locally to prevent idle shutdown
      // during long operations (agent install, config). Stopped when
      // the interactive session starts (remote keep-alive takes over).
      startLocalKeepAlive();
      await setupShellEnvironment();
      await installSpriteKeepAlive();
      return getVmConnection();
    },
    getServerName,
    async waitForReady() {},
    async interactiveSession(cmd: string, spawnFn?: (args: string[]) => number) {
      stopLocalKeepAlive();
      return interactiveSession(cmd, spawnFn);
    },
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
