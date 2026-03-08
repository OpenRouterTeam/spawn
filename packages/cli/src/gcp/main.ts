#!/usr/bin/env bun

// gcp/main.ts — Orchestrator: deploys an agent on GCP Compute Engine

import type { CloudOrchestrator } from "../shared/orchestrate";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { agents, resolveAgent } from "./agents";
import {
  authenticate,
  checkBillingEnabled,
  createInstance,
  ensureGcloudCli,
  getServerName,
  interactiveSession,
  promptMachineType,
  promptSpawnName,
  promptZone,
  resolveProject,
  runServer,
  uploadFile,
  waitForCloudInit,
} from "./gcp";

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
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      await createInstance(name, zone, machineType, agent.cloudInitTier);
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
