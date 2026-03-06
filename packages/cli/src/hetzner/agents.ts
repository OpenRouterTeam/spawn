// hetzner/agents.ts — Hetzner Cloud agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { runServer, uploadFile } from "./hetzner";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
