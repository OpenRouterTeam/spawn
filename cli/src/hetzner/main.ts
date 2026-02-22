#!/usr/bin/env bun
// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import {
  ensureHcloudToken,
  ensureSshKey,
  promptSpawnName,
  createServer as createHetznerServer,
  getServerName,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
  saveLaunchCmd,
} from "./hetzner";
import { resolveAgent } from "./agents";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run hetzner/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "hetzner",
    cloudLabel: "Hetzner Cloud",
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureHcloudToken();
      await ensureSshKey();
    },
    async promptSize() {},
    async createServer(name: string) {
      await createHetznerServer(name, undefined, undefined, agent.cloudInitTier);
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
