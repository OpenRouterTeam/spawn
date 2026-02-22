#!/usr/bin/env bun
// aws/main.ts — Orchestrator: deploys an agent on AWS Lightsail

import {
  ensureAwsCli,
  authenticate,
  promptRegion,
  promptBundle,
  ensureSshKey,
  promptSpawnName,
  createInstance,
  waitForInstance,
  waitForCloudInit,
  getServerName,
  runServer,
  uploadFile,
  interactiveSession,
  saveLaunchCmd,
} from "./aws";
import { resolveAgent } from "./agents";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run aws/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "aws",
    cloudLabel: "AWS Lightsail",
    runner: { runServer, uploadFile },
    async authenticate() {
      await promptSpawnName();
      await ensureAwsCli();
      await authenticate();
      await promptRegion();
      await promptBundle();
      await ensureSshKey();
    },
    async promptSize() {
      // Bundle selection handled during authenticate()
    },
    async createServer(name: string) {
      await createInstance(name);
    },
    getServerName,
    async waitForReady() {
      await waitForInstance();
      await waitForCloudInit();
    },
    interactiveSession,
    saveLaunchCmd,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  const msg =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  process.stderr.write(`\x1b[0;31mFatal: ${msg}\x1b[0m\n`);
  process.exit(1);
});
