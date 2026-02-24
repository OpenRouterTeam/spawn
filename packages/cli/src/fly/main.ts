#!/usr/bin/env bun
// fly/main.ts — Orchestrator: deploys an agent on Fly.io

import {
  ensureFlyCli,
  ensureFlyToken,
  promptOrg,
  promptSpawnName,
  createServer,
  getServerName,
  waitForCloudInit,
  waitForSsh,
  runServer,
  uploadFile,
  interactiveSession,
  FLY_VM_TIERS,
  DEFAULT_VM_TIER,
} from "./fly";
import type { ServerOptions } from "./fly";
import { resolveAgent } from "./agents";
import { saveLaunchCmd } from "../history.js";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";
import { selectFromList } from "../shared/ui";

async function promptVmOptions(): Promise<ServerOptions> {
  if (process.env.FLY_VM_MEMORY) {
    const memoryMb = Number.parseInt(process.env.FLY_VM_MEMORY, 10);
    const tier = FLY_VM_TIERS.find((t) => t.memoryMb === memoryMb) || DEFAULT_VM_TIER;
    return {
      cpuKind: tier.cpuKind,
      cpus: tier.cpus,
      memoryMb: tier.memoryMb,
    };
  }

  if (process.env.SPAWN_CUSTOM !== "1") {
    return {
      cpuKind: DEFAULT_VM_TIER.cpuKind,
      cpus: DEFAULT_VM_TIER.cpus,
      memoryMb: DEFAULT_VM_TIER.memoryMb,
    };
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return {
      cpuKind: DEFAULT_VM_TIER.cpuKind,
      cpus: DEFAULT_VM_TIER.cpus,
      memoryMb: DEFAULT_VM_TIER.memoryMb,
    };
  }

  process.stderr.write("\n");
  const tierItems = FLY_VM_TIERS.map((t) => `${t.id}|${t.label}`);
  const tierId = await selectFromList(tierItems, "VM size", DEFAULT_VM_TIER.id);
  const selectedTier = FLY_VM_TIERS.find((t) => t.id === tierId) || DEFAULT_VM_TIER;

  return {
    cpuKind: selectedTier.cpuKind,
    cpus: selectedTier.cpus,
    memoryMb: selectedTier.memoryMb,
  };
}

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run fly/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let serverOpts: ServerOptions;

  const cloud: CloudOrchestrator = {
    cloudName: "fly",
    cloudLabel: "Fly.io",
    runner: {
      runServer,
      uploadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureFlyCli();
      await ensureFlyToken();
      await promptOrg();
    },
    async promptSize() {
      serverOpts = await promptVmOptions();
    },
    getServerName,
    async createServer(name: string) {
      await createServer(name, serverOpts, agent.image);
    },
    async waitForReady() {
      if (agent.image) {
        // Custom image already has packages baked in — just wait for SSH
        await waitForSsh();
      } else {
        await waitForCloudInit(agent.cloudInitTier);
      }
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
