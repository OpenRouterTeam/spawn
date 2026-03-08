#!/usr/bin/env bun

// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import type { CloudOrchestrator } from "../shared/orchestrate";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { agents, resolveAgent } from "./agents";
import {
  createServer as createHetznerServer,
  ensureHcloudToken,
  ensureSshKey,
  getServerName,
  interactiveSession,
  promptLocation,
  promptServerType,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
} from "./hetzner";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run hetzner/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let serverType = "";
  let location = "";

  const cloud: CloudOrchestrator = {
    cloudName: "hetzner",
    cloudLabel: "Hetzner Cloud",
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureHcloudToken();
      await ensureSshKey();
    },
    async promptSize() {
      serverType = await promptServerType();
      location = await promptLocation();
    },
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      await createHetznerServer(name, serverType, location, agent.cloudInitTier);
    },
    getServerName,
    async waitForReady() {
      await waitForCloudInit();
    },
    interactiveSession,
    saveLaunchCmd: (cmd: string, sid?: string) => saveLaunchCmd(cmd, sid),
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
