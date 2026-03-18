#!/usr/bin/env bun

// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import type { CloudOrchestrator } from "../shared/orchestrate";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate";
import { agents, resolveAgent } from "./agents";
import {
  createServer as createHetznerServer,
  downloadFile,
  ensureHcloudToken,
  ensureSshKey,
  findSpawnSnapshot,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  promptLocation,
  promptServerType,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
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
  let snapshotId: string | null = null;

  const cloud: CloudOrchestrator = {
    cloudName: "hetzner",
    cloudLabel: "Hetzner Cloud",
    skipAgentInstall: false,
    runner: {
      runServer,
      uploadFile,
      downloadFile,
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
    async createServer(name: string) {
      // Check for a pre-built snapshot before provisioning
      snapshotId = await findSpawnSnapshot(agentName);
      if (snapshotId) {
        cloud.skipAgentInstall = true;
      }
      return await createHetznerServer(name, serverType, location, agent.cloudInitTier, snapshotId ?? undefined);
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
    getConnectionInfo,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
