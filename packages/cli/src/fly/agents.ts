// fly/agents.ts — Fly.io agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./fly";
import {
  createAgents,
  installAgent,
  setupOpenclawBatched,
  resolveAgent as _resolveAgent,
  offerGithubAuth as _offerGithubAuth,
} from "../shared/agent-setup";
import type { CloudRunner } from "../shared/agent-setup";
import type { AgentConfig } from "../shared/agents";
import { generateEnvConfig } from "../shared/agents";
import { logInfo, logStep } from "../shared/ui";

/** Fly extends AgentConfig with an optional Docker image field. */
export interface FlyAgentConfig extends AgentConfig {
  image?: string;
}

export type { AgentConfig };
export { generateEnvConfig };

const runner: CloudRunner = {
  runServer,
  uploadFile,
};

// Start from default agents, then override Fly-specific differences
export const agents: Record<string, FlyAgentConfig> = (() => {
  const base = createAgents(runner);
  const fly: Record<string, FlyAgentConfig> = {
    ...base,
  };

  // Fly openclaw uses a pre-built Docker image + batched setup (2 SSH sessions total)
  fly.openclaw = {
    ...base.openclaw,
    image: "ghcr.io/openrouterteam/spawn-openclaw:latest",
    install: async () => {
      logStep("Verifying openclaw installation...");
      try {
        await runServer("command -v openclaw");
        logInfo("openclaw is pre-installed");
      } catch {
        logInfo("openclaw not found in image, installing from scratch...");
        await installAgent(
          runner,
          "openclaw",
          'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" && npm install -g openclaw && command -v openclaw',
        );
      }
    },
    setup: (envContent, apiKey, modelId) =>
      setupOpenclawBatched(runner, envContent, apiKey, modelId || "openrouter/auto"),
  };

  return fly;
})();

export function resolveAgent(name: string): FlyAgentConfig {
  const agent = agents[name.toLowerCase()];
  if (!agent) {
    // Fall back to shared resolver for error handling
    _resolveAgent(agents, name);
    throw new Error(`Unknown agent: ${name}`);
  }
  return agent;
}

export function offerGithubAuth(): Promise<void> {
  return _offerGithubAuth(runner);
}
