#!/usr/bin/env bun
// daytona/main.ts — Orchestrator: deploys an agent on Daytona

import {
  ensureDaytonaToken,
  promptSpawnName,
  getServerName,
  createServer as createDaytonaServer,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
  saveLaunchCmd,
} from "./daytona";
import { resolveAgent } from "./agents";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run daytona/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "daytona",
    cloudLabel: "Daytona",
    runner: { runServer, uploadFile },
    async authenticate() {
      await promptSpawnName();
      await ensureDaytonaToken();
    },
    async promptSize() {},
    async createServer(name: string) {
      await createDaytonaServer(name);
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
  const msg =
    err && typeof err === "object" && "message" in err
      ? String(err.message)
      : String(err);
  process.stderr.write(`\x1b[0;31mFatal: ${msg}\x1b[0m\n`);
  process.exit(1);
});
