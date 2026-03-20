// hetzner/agents.ts — Hetzner Cloud agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runServer, uploadFile } from "./hetzner.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
