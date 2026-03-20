#!/usr/bin/env bun

// gcp/main.ts — Orchestrator: deploys an agent on GCP Compute Engine

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate.js";
import { agents, resolveAgent } from "./agents.js";
import {
  authenticate,
  checkBillingEnabled,
  createInstance,
  downloadFile,
  ensureGcloudCli,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  promptMachineType,
  promptSpawnName,
  promptZone,
  resolveProject,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./gcp.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run gcp/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let machineType = "";
  let zone = "";

  const cloud: CloudOrchestrator = {
    cloudName: "gcp",
    cloudLabel: "GCP Compute Engine",
    runner: {
      runServer,
      uploadFile,
      downloadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureGcloudCli();
      await authenticate();
      await resolveProject();
    },
    async checkAccountReady() {
      await checkBillingEnabled();
    },
    async promptSize() {
      machineType = await promptMachineType();
      zone = await promptZone();
    },
    async createServer(name: string) {
      return await createInstance(name, zone, machineType, agent.cloudInitTier);
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
