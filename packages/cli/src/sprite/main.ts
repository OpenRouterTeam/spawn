#!/usr/bin/env bun

// sprite/main.ts — Orchestrator: deploys an agent on Sprite

import type { CloudOrchestrator } from "../shared/orchestrate";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { agents, resolveAgent } from "./agents";
import {
  createSprite,
  ensureSpriteAuthenticated,
  ensureSpriteCli,
  getServerName,
  interactiveSession,
  promptSpawnName,
  runSprite,
  saveVmConnection,
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
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      await createSprite(name);
      await verifySpriteConnectivity();
      await setupShellEnvironment();
      saveVmConnection();
    },
    getServerName,
    async waitForReady() {},
    interactiveSession,
    saveLaunchCmd: (cmd: string, sid?: string) => saveLaunchCmd(cmd, sid),
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  process.stderr.write(`\x1b[0;31mFatal: ${msg}\x1b[0m\n`);
  process.exit(1);
});
