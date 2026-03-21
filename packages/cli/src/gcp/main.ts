#!/usr/bin/env bun

// gcp/main.ts — Orchestrator: deploys an agent on GCP Compute Engine

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { runOrchestration } from "../shared/orchestrate.js";
import { logInfo, logStep, shellQuote } from "../shared/ui.js";
import { agents, resolveAgent } from "./agents.js";
import {
  authenticate,
  checkBillingEnabled,
  createInstance,
  downloadFile,
  ensureGcloudCli,
  getConnectionInfo,
  getServerName,
  interactiveSession,
  promptMachineType,
  promptSpawnName,
  promptZone,
  resolveProject,
  runServer,
  uploadFile,
  waitForCloudInit,
  waitForSshOnly,
} from "./gcp.js";

const DOCKER_CONTAINER_NAME = "spawn-agent";
const DOCKER_REGISTRY = "ghcr.io/openrouterteam";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run gcp/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  const agent = resolveAgent(agentName);

  let machineType = "";
  let zone = "";
  let useDocker = false;

  // Check if --beta docker is active
  const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
  if (betaFeatures.includes("docker")) {
    useDocker = true;
  }

  /** Wrap a command to run inside the Docker container instead of the host. */
  function dockerExec(cmd: string): string {
    return `docker exec ${DOCKER_CONTAINER_NAME} bash -c ${shellQuote(cmd)}`;
  }

  const cloud: CloudOrchestrator = {
    cloudName: "gcp",
    cloudLabel: "GCP Compute Engine",
    runner: {
      runServer: useDocker ? (cmd: string, timeoutSecs?: number) => runServer(dockerExec(cmd), timeoutSecs) : runServer,
      uploadFile,
      downloadFile,
    },
    async authenticate() {
      await promptSpawnName();
      await ensureGcloudCli();
      await authenticate();
      await resolveProject();
    },
    async checkAccountReady() {
      await checkBillingEnabled();
    },
    async promptSize() {
      machineType = await promptMachineType();
      zone = await promptZone();
    },
    async createServer(name: string) {
      return await createInstance(
        name,
        zone,
        machineType,
        agent.cloudInitTier,
        useDocker ? "cos-stable" : undefined,
        useDocker ? "cos-cloud" : undefined,
      );
    },
    getServerName,
    async waitForReady() {
      if (useDocker || cloud.skipCloudInit) {
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

main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
