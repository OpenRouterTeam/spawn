#!/usr/bin/env bun

// daytona/main.ts — Orchestrator: deploys an agent on Daytona

import type { CloudOrchestrator } from "../shared/orchestrate";
import type { SandboxSize } from "./daytona";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { agents, resolveAgent } from "./agents";
import {
  createServer as createDaytonaServer,
  ensureDaytonaToken,
  getServerName,
  interactiveSession,
  promptSandboxSize,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
} from "./daytona";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run daytona/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let sandboxSize: SandboxSize | undefined;

  const cloud: CloudOrchestrator = {
    cloudName: "daytona",
    cloudLabel: "Daytona",
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureDaytonaToken();
    },
    async promptSize() {
      sandboxSize = await promptSandboxSize();
    },
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      await createDaytonaServer(name, sandboxSize);
    },
    getServerName,
    async waitForReady() {
      await waitForCloudInit(agent.cloudInitTier);
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
