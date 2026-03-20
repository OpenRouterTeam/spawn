// gcp/agents.ts — GCP Compute Engine agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runServer, uploadFile } from "./gcp.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
