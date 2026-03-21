#!/usr/bin/env bun

// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { logInfo } from "../shared/log.js";
import { runOrchestration } from "../shared/orchestrate.js";
import { agents, resolveAgent } from "./agents.js";
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
} from "./hetzner.js";

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
  let dockerImage: string | undefined;

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
      // Use Docker CE app image when --beta docker is active (and no snapshot found)
      if (!snapshotId) {
        const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
        if (betaFeatures.includes("docker")) {
          dockerImage = "docker-ce";
          logInfo("Using Hetzner Docker CE app image");
        }
      }
      return await createHetznerServer(
        name,
        serverType,
        location,
        agent.cloudInitTier,
        snapshotId ?? undefined,
        dockerImage,
      );
    },
    getServerName,
    async waitForReady() {
      if (snapshotId || cloud.skipCloudInit) {
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
