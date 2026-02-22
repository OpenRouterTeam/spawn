#!/usr/bin/env bun
// local/main.ts — Orchestrator: deploys an agent on the local machine

import {
  runLocal,
  uploadFile,
  interactiveSession,
  saveLocalConnection,
  saveLaunchCmd,
} from "./local";
import { resolveAgent } from "./agents";
import { runOrchestration } from "../shared/orchestrate";
import type { CloudOrchestrator } from "../shared/orchestrate";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run local/main.ts <agent>");
    console.error("Agents: claude, codex, openclaw, opencode, kilocode, zeroclaw");
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "local",
    cloudLabel: "local machine",
    runner: {
      runServer: runLocal,
      uploadFile: async (l: string, r: string) => uploadFile(l, r),
    },
    async authenticate() {
      saveLocalConnection();
    },
    async promptSize() {},
    async createServer() {},
    async getServerName() {
      const result = Bun.spawnSync(["hostname"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      return new TextDecoder().decode(result.stdout).trim() || "local";
    },
    async waitForReady() {},
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
