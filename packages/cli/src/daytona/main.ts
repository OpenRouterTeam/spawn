#!/usr/bin/env bun

// daytona/main.ts — Orchestrator: deploys an agent on Daytona

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate.js";
import { agents, resolveAgent } from "./agents.js";
import {
  createServer,
  downloadFile,
  ensureDaytonaAuthenticated,
  getServerName,
  getSignedPreviewBrowserUrl,
  interactiveSession,
  promptSandboxSize,
  promptSpawnName,
  runServer,
  setupAutoUpdateSession,
  uploadFile,
  waitForReady,
} from "./daytona.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run daytona/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  const cloud: CloudOrchestrator = {
    cloudName: "daytona",
    cloudLabel: "Daytona",
    runner: {
      runServer,
      uploadFile,
      downloadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureDaytonaAuthenticated();
    },
    async promptSize() {
      await promptSandboxSize();
    },
    async createServer(name: string) {
      return createServer(name);
    },
    getServerName,
    async waitForReady() {
      await waitForReady();
    },
    interactiveSession,
    async setupAutoUpdate(agentName: string, updateCmd: string) {
      await setupAutoUpdateSession(agentName, updateCmd);
    },
    async getSignedPreviewUrl(remotePort: number, urlSuffix?: string, expiresInSeconds?: number) {
      return getSignedPreviewBrowserUrl(undefined, remotePort, urlSuffix, expiresInSeconds);
    },
  };

  await runOrchestration(cloud, agent, agentName);
}

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
