// digitalocean/agents.ts — DigitalOcean agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./digitalocean";
import { createAgents, resolveAgent as _resolveAgent } from "../shared/agent-setup";
import type { AgentConfig } from "../shared/agents";

const runner = {
  runServer,
  uploadFile,
};

export const agents = createAgents(runner);

export function resolveAgent(name: string): AgentConfig {
  return _resolveAgent(agents, name);
}
