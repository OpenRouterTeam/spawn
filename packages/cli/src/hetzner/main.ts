#!/usr/bin/env bun

// hetzner/main.ts — Orchestrator: deploys an agent on Hetzner Cloud

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import pkg from "../../package.json" with { type: "json" };
import { shouldSkipCloudInit } from "../shared/cloud-init.js";
import { DOCKER_CONTAINER_NAME, DOCKER_REGISTRY, makeDockerRunner, runOrchestration } from "../shared/orchestrate.js";
import { initTelemetry } from "../shared/telemetry.js";
import { logInfo, logStep, shellQuote } from "../shared/ui.js";
import { agents, resolveAgent } from "./agents.js";
import {
  cleanupOrphanedPrimaryIps,
  createServer as createHetznerServer,
  downloadFile,
  ensureHcloudToken,
  ensureSshKey,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  promptLocation,
  promptServerType,
  promptSpawnName,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./hetzner.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run hetzner/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let serverType = "";
  let location = "";
  let useDocker = false;

  // Check if --beta docker is active
  const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
  if (betaFeatures.includes("docker")) {
    useDocker = true;
  }

  const cloud: CloudOrchestrator = {
    cloudName: "hetzner",
    cloudLabel: "Hetzner Cloud",
    skipAgentInstall: false,
    runner: useDocker
      ? makeDockerRunner({
          runServer,
          uploadFile,
          downloadFile,
        })
      : {
          runServer,
          uploadFile,
          downloadFile,
        },
    async authenticate() {
      await promptSpawnName();
      await ensureHcloudToken();
      await ensureSshKey();
    },
    async promptSize() {
      serverType = await promptServerType();
      location = await promptLocation();
    },
    async createServer(name: string) {
      // Proactively clean up orphaned Primary IPs before provisioning in headless
      // mode (E2E batches). This prevents resource_limit_exceeded errors when
      // previous test runs left behind unattached IPs that consume quota (#2933).
      if (process.env.SPAWN_NON_INTERACTIVE === "1") {
        const cleaned = await cleanupOrphanedPrimaryIps();
        if (cleaned > 0) {
          logInfo(`Pre-provisioning: cleaned ${cleaned} orphaned Primary IP(s)`);
        }
      }

      return await createHetznerServer(
        name,
        serverType,
        location,
        agent.cloudInitTier,
        undefined,
        useDocker ? "docker-ce" : undefined,
      );
    },
    getServerName,
    async waitForReady() {
      if (
        shouldSkipCloudInit({
          useDocker,
          skipCloudInit: cloud.skipCloudInit,
        })
      ) {
        await waitForSshOnly();
      } else {
        await waitForCloudInit();
      }

      // Pull and start the agent Docker container after the server is ready
      if (useDocker) {
        const image = `${DOCKER_REGISTRY}/spawn-${agentName}:latest`;
        logStep(`Pulling Docker image ${image}...`);
        await runServer(`docker pull ${image}`, 300);
        logStep("Starting agent container...");
        await runServer(`docker run -d --name ${DOCKER_CONTAINER_NAME} --network host ${image}`);
        cloud.skipAgentInstall = true;
        logInfo("Agent container running");
      }
    },
    interactiveSession: useDocker
      ? (cmd: string) => interactiveSession(`docker exec -it ${DOCKER_CONTAINER_NAME} bash -l -c ${shellQuote(cmd)}`)
      : interactiveSession,
    getConnectionInfo,
  };

  await runOrchestration(cloud, agent, agentName);
}

initTelemetry(pkg.version);
main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
