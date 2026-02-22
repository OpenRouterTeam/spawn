#!/usr/bin/env bun
// digitalocean/main.ts — Orchestrator: deploys an agent on DigitalOcean

import {
  ensureDoToken,
  ensureSshKey,
  promptSpawnName,
  createServer as createDroplet,
  getServerName,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
  saveLaunchCmd,
} from "./digitalocean";
import { resolveAgent } from "./agents";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run digitalocean/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "digitalocean",
    cloudLabel: "DigitalOcean",
    runner: { runServer, uploadFile },
    async authenticate() {
      await promptSpawnName();
      await ensureDoToken();
      await ensureSshKey();
    },
    async promptSize() {},
    async createServer(name: string) {
      await createDroplet(name);
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
