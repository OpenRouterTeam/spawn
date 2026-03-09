#!/usr/bin/env bun

// local/main.ts — Orchestrator: deploys an agent on the local machine

import type { CloudOrchestrator } from "../shared/orchestrate";

import { runOrchestration } from "../shared/orchestrate";
import { getErrorMessage } from "../shared/type-guards.js";
import { agents, resolveAgent } from "./agents";
import { interactiveSession, runLocal, uploadFile } from "./local";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run local/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
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
    async authenticate() {},
    async promptSize() {},
    async createServer(_name: string) {
      return {
        ip: "localhost",
        user: process.env.USER || "local",
        cloud: "local",
      };
    },
    async getServerName() {
      const result = Bun.spawnSync(
        [
          "hostname",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "ignore",
          ],
        },
      );
      return new TextDecoder().decode(result.stdout).trim() || "local";
    },
    async waitForReady() {},
    interactiveSession,
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
