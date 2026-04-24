#!/usr/bin/env bun

// local/main.ts — Orchestrator: deploys an agent on the local machine

import type { CloudOrchestrator } from "../shared/orchestrate.js";

import * as p from "@clack/prompts";
import { getErrorMessage } from "@openrouter/spawn-shared";
import pkg from "../../package.json" with { type: "json" };
import { createCloudAgents } from "../shared/agent-setup.js";
import { makeDockerRunner, runOrchestration } from "../shared/orchestrate.js";
import { initTelemetry } from "../shared/telemetry.js";
import { logWarn } from "../shared/ui.js";
import { agents, resolveAgent } from "./agents.js";
import {
  cleanupContainer,
  dockerInteractiveSession,
  downloadFile,
  ensureDocker,
  interactiveSession,
  pullAndStartContainer,
  runLocal,
  uploadFile,
} from "./local.js";

async function main() {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("Usage: bun run local/main.ts <agent>");
    console.error(`Agents: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }

  // Check if --beta sandbox is active
  const betaFeatures = (process.env.SPAWN_BETA ?? "").split(",");
  const useSandbox = betaFeatures.includes("sandbox");

  const baseRunner = {
    runServer: runLocal,
    uploadFile: async (l: string, r: string) => uploadFile(l, r),
    downloadFile: async (r: string, l: string) => downloadFile(r, l),
  };

  // When sandboxed, recreate agents with the Docker-wrapped runner so that
  // agent.configure() / agent.install() closures execute inside the container
  // instead of writing config files directly to the host filesystem.
  const agent = useSandbox
    ? createCloudAgents(makeDockerRunner(baseRunner)).resolveAgent(agentName)
    : resolveAgent(agentName);

  // If sandboxed, ensure Docker is installed (auto-install if missing)
  if (useSandbox) {
    await ensureDocker();
  }

  // Warn about security implications of installing OpenClaw locally
  // (skip warning in sandbox mode — the container provides isolation)
  if (agentName === "openclaw" && !useSandbox && process.env.SPAWN_NON_INTERACTIVE !== "1") {
    process.stderr.write("\n");
    logWarn("⚠  Local installation warning");
    logWarn(`   This will install ${agent.name} directly on your machine.`);
    logWarn("   The agent will have full access to your filesystem, shell, and network.");
    logWarn("   For isolation, consider running on a cloud VM instead.\n");

    const confirmed = await p.confirm({
      message: "Continue with local installation?",
      initialValue: true,
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.log.info("Installation cancelled.");
      process.exit(0);
    }
  }

  const cloud: CloudOrchestrator = {
    cloudName: "local",
    cloudLabel: useSandbox ? "local (sandboxed)" : "local",
    skipAgentInstall: false,
    runner: useSandbox ? makeDockerRunner(baseRunner) : baseRunner,
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
    async waitForReady() {
      if (useSandbox) {
        await pullAndStartContainer(agentName);
        cloud.skipAgentInstall = true;
      }
    },
    interactiveSession: useSandbox ? dockerInteractiveSession : interactiveSession,
  };

  // Clean up sandbox container on exit
  if (useSandbox) {
    process.on("exit", cleanupContainer);
  }

  await runOrchestration(cloud, agent, agentName);
}

initTelemetry(pkg.version);
main().catch((err) => {
  process.stderr.write(`\x1b[0;31mFatal: ${getErrorMessage(err)}\x1b[0m\n`);
  process.exit(1);
});
