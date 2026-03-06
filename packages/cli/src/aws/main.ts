#!/usr/bin/env bun

// aws/main.ts — Orchestrator: deploys an agent on AWS Lightsail

import type { CloudOrchestrator } from "../shared/orchestrate";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { agents, resolveAgent } from "./agents";
import {
  authenticate,
  createInstance,
  ensureAwsCli,
  ensureSshKey,
  getServerName,
  interactiveSession,
  promptBundle,
  promptRegion,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForInstance,
} from "./aws";

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
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      await createInstance(name, agent.cloudInitTier);
    },
    getServerName,
    async waitForReady() {
      await waitForInstance();
      await waitForCloudInit();
    },
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
