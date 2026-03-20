#!/usr/bin/env bun

// aws/main.ts — Orchestrator: deploys an agent on AWS Lightsail

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate.js";
import { agents, resolveAgent } from "./agents.js";
import {
  authenticate,
  createInstance,
  downloadFile,
  ensureAwsCli,
  ensureSshKey,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  promptBundle,
  promptRegion,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./aws.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run aws/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "aws",
    cloudLabel: "AWS Lightsail",
    runner: {
      runServer,
      uploadFile,
      downloadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureAwsCli();
      await authenticate();
      await promptRegion();
      await promptBundle(agentName);
      await ensureSshKey();
    },
    async promptSize() {
      // Bundle selection handled during authenticate()
    },
    async createServer(name: string) {
      return await createInstance(name, agent.cloudInitTier);
    },
    getServerName,
    async waitForReady() {
      if (cloud.skipCloudInit) {
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
