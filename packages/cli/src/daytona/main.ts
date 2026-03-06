#!/usr/bin/env bun
// daytona/main.ts — Orchestrator: deploys an agent on Daytona

import {
  ensureDaytonaToken,
  promptSpawnName,
  promptSandboxSize,
  getServerName,
  createServer as createDaytonaServer,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
} from "./daytona";
import type { SandboxSize } from "./daytona";
import { agents, resolveAgent } from "./agents";
import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

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
