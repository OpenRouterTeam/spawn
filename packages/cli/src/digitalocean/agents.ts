// digitalocean/agents.ts — DigitalOcean agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runServer, uploadFile } from "./digitalocean.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
