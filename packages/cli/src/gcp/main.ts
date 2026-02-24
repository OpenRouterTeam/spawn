#!/usr/bin/env bun
// gcp/main.ts — Orchestrator: deploys an agent on GCP Compute Engine

import {
  ensureGcloudCli,
  authenticate,
  resolveProject,
  promptSpawnName,
  promptMachineType,
  promptZone,
  getServerName,
  createInstance,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
} from "./gcp";
import { resolveAgent } from "./agents";
import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run gcp/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
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
    async promptSize() {
      machineType = await promptMachineType();
      zone = await promptZone();
    },
    async createServer(name: string) {
      await createInstance(name, zone, machineType, agent.cloudInitTier);
    },
    getServerName,
    async waitForReady() {
      await waitForCloudInit();
    },
    interactiveSession,
    saveLaunchCmd,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  const msg = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  process.stderr.write(`\x1b[0;31mFatal: ${msg}\x1b[0m\n`);
  process.exit(1);
});
