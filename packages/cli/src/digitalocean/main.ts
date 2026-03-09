#!/usr/bin/env bun

// digitalocean/main.ts — Orchestrator: deploys an agent on DigitalOcean

import type { CloudOrchestrator } from "../shared/orchestrate";

import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { agents, resolveAgent } from "./agents";
import {
  checkAccountStatus,
  createServer as createDroplet,
  ensureDoToken,
  ensureSshKey,
  findSpawnSnapshot,
  getServerName,
  interactiveSession,
  promptDoRegion,
  promptDropletSize,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./digitalocean";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run digitalocean/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let dropletSize = "";
  let region = "";
  let snapshotId: string | null = null;

  const cloud: CloudOrchestrator = {
    cloudName: "digitalocean",
    cloudLabel: "DigitalOcean",
    skipAgentInstall: false,
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureDoToken();
      await ensureSshKey();
    },
    async checkAccountReady() {
      await checkAccountStatus();
    },
    async promptSize() {
      dropletSize = await promptDropletSize();
      region = await promptDoRegion();
    },
    async createServer(name: string) {
      // Check for a pre-built snapshot before provisioning
      snapshotId = await findSpawnSnapshot(agentName);
      if (snapshotId) {
        cloud.skipAgentInstall = true;
      }
      return await createDroplet(name, agent.cloudInitTier, dropletSize, region, snapshotId ?? undefined);
    },
    getServerName,
    async waitForReady() {
      if (snapshotId) {
        await waitForSshOnly();
      } else {
        await waitForCloudInit();
      }
    },
    interactiveSession,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
