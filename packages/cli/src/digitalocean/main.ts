#!/usr/bin/env bun
// digitalocean/main.ts — Orchestrator: deploys an agent on DigitalOcean

import {
  ensureDoToken,
  ensureSshKey,
  promptSpawnName,
  promptDropletSize,
  promptDoRegion,
  createServer as createDroplet,
  getServerName,
  waitForCloudInit,
  runServer,
  uploadFile,
  interactiveSession,
} from "./digitalocean";
import { resolveAgent } from "./agents";
import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";
import { logStep } from "../shared/ui";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run digitalocean/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let dropletSize = "";
  let region = "";

  const cloud: CloudOrchestrator = {
    cloudName: "digitalocean",
    cloudLabel: "DigitalOcean",
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
    async createServer(name: string) {
      await createDroplet(name, agent.cloudInitTier, dropletSize, region);
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
