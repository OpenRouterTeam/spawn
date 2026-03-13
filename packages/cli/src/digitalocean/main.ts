#!/usr/bin/env bun

// digitalocean/main.ts — Orchestrator: deploys an agent on DigitalOcean

import type { CloudOrchestrator } from "../shared/orchestrate";

import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { logInfo } from "../shared/ui";
import { agents, resolveAgent } from "./agents";
import {
  checkAccountStatus,
  createServer as createDroplet,
  ensureDoToken,
  ensureSshKey,
  getConnectionInfo,
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

/** Agents that need more than the default 2GB RAM (e.g. openclaw-plugins OOMs on 2GB) */
const AGENT_MIN_SIZE: Record<string, string> = {
  openclaw: "s-2vcpu-4gb",
};

/** DO marketplace image slugs — hardcoded from vendor portal (approved 2026-03-13) */
const MARKETPLACE_IMAGES: Record<string, string> = {
  claude: "openrouter-spawnclaude",
  codex: "openrouter-spawncodex",
  openclaw: "openrouter-spawnopenclaw",
  opencode: "openrouter-spawnopencode",
  kilocode: "openrouter-spawnkilocode",
  zeroclaw: "openrouter-spawnzeroclaw",
  hermes: "openrouter-spawnhermes",
  junie: "openrouter-spawnjunie",
};

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
  let marketplaceImage: string | undefined;

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
      await ensureDoToken();
      await ensureSshKey();
    },
    async checkAccountReady() {
      await checkAccountStatus();
    },
    async promptSize() {
      dropletSize = await promptDropletSize();
      // Enforce minimum size for agents that need more RAM (e.g. openclaw-plugins OOMs on 2GB)
      const minSize = AGENT_MIN_SIZE[agentName];
      if (minSize && (!dropletSize || dropletSize === "s-2vcpu-2gb")) {
        dropletSize = minSize;
        logInfo(`Using ${minSize} (minimum for ${agentName})`);
      }
      region = await promptDoRegion();
    },
    async createServer(name: string) {
      // Use pre-built marketplace image when --beta images is active
      const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
      if (betaFeatures.includes("images")) {
        const slug = MARKETPLACE_IMAGES[agentName];
        if (slug) {
          marketplaceImage = slug;
          cloud.skipAgentInstall = true;
          logInfo(`Using marketplace image: ${slug}`);
        } else {
          logInfo(`No marketplace image for ${agentName}, using fresh install`);
        }
      }
      return await createDroplet(name, agent.cloudInitTier, dropletSize, region, marketplaceImage);
    },
    getServerName,
    async waitForReady() {
      if (marketplaceImage) {
        await waitForSshOnly();
      } else {
        await waitForCloudInit();
      }
    },
    interactiveSession,
    getConnectionInfo,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
