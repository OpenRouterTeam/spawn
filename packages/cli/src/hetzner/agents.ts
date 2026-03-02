// hetzner/agents.ts — Hetzner Cloud agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./hetzner";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
