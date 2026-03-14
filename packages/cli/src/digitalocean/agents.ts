// digitalocean/agents.ts — DigitalOcean agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { downloadFile, runServer, uploadFile } from "./digitalocean";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
