// sprite/agents.ts — Sprite agent configs (thin wrapper over shared)

import { runSprite, uploadFileSprite } from "./sprite";
import {
  createAgents,
  resolveAgent as _resolveAgent,
  offerGithubAuth as _offerGithubAuth,
} from "../shared/agent-setup";
import type { AgentConfig } from "../shared/agents";
import { generateEnvConfig } from "../shared/agents";

export type { AgentConfig };
export { generateEnvConfig };

const runner = { runServer: runSprite, uploadFile: uploadFileSprite };

export const agents = createAgents(runner);

export function resolveAgent(name: string): AgentConfig {
  return _resolveAgent(agents, name);
}

export function offerGithubAuth(): Promise<void> {
  return _offerGithubAuth(runner);
}
