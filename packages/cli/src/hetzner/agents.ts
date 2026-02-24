// hetzner/agents.ts — Hetzner Cloud agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./hetzner";
import {
  createAgents,
  resolveAgent as _resolveAgent,
  offerGithubAuth as _offerGithubAuth,
} from "../shared/agent-setup";
import type { AgentConfig } from "../shared/agents";
import { generateEnvConfig } from "../shared/agents";

export type { AgentConfig };
export { generateEnvConfig };

const runner = {
  runServer,
  uploadFile,
};

export const agents = createAgents(runner);

export function resolveAgent(name: string): AgentConfig {
  return _resolveAgent(agents, name);
}

export function offerGithubAuth(): Promise<void> {
  return _offerGithubAuth(runner);
}
