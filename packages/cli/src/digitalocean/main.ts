#!/usr/bin/env bun

// digitalocean/main.ts — Orchestrator: deploys an agent on DigitalOcean

import type { CloudOrchestrator } from "../shared/orchestrate";

import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import { logStep } from "../shared/ui";
import { agents, resolveAgent } from "./agents";
import {
  createServer as createDroplet,
  ensureDoToken,
  ensureSshKey,
  findSpawnSnapshot,
  getServerName,
  interactiveSession,
  promptDoRegion,
  promptDropletSize,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./digitalocean";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run digitalocean/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let dropletSize = "";
  let region = "";
  let snapshotId: string | null = null;

  const cloud: CloudOrchestrator = {
    cloudName: "digitalocean",
    cloudLabel: "DigitalOcean",
    skipAgentInstall: false,
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      const usedBrowserAuth = await ensureDoToken();
      await ensureSshKey();
      if (usedBrowserAuth) {
        logStep("Next step: OpenRouter authentication (opening browser in 5s)...");
        await new Promise((r) => setTimeout(r, 5000));
      }
    },
    async promptSize() {
      dropletSize = await promptDropletSize();
      region = await promptDoRegion();
    },
    async createServer(name: string, spawnId?: string) {
      process.env.SPAWN_ID = spawnId || "";
      // Check for a pre-built snapshot before provisioning
      snapshotId = await findSpawnSnapshot(agentName);
      if (snapshotId) {
        cloud.skipAgentInstall = true;
      }
      await createDroplet(name, agent.cloudInitTier, dropletSize, region, snapshotId ?? undefined);
    },
    getServerName,
    async waitForReady() {
      if (snapshotId) {
        await waitForSshOnly();
      } else {
        await waitForCloudInit();
      }
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
