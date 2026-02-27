// local/agents.ts — Local machine agent configs (thin wrapper over shared)

import { runLocal, uploadFile } from "./local";
import { createAgents, resolveAgent as _resolveAgent } from "../shared/agent-setup";
import type { AgentConfig } from "../shared/agents";
import { generateEnvConfig } from "../shared/agents";

export type { AgentConfig };
export { generateEnvConfig };

const runner = {
  runServer: runLocal,
  uploadFile: async (l: string, r: string) => uploadFile(l, r),
};

export const agents = createAgents(runner);

export function resolveAgent(name: string): AgentConfig {
  return _resolveAgent(agents, name);
}
