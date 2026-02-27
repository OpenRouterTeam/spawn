// daytona/agents.ts — Daytona agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./daytona";
import {
  createAgents,
  resolveAgent as _resolveAgent,
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
