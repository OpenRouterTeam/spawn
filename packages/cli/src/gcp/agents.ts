// gcp/agents.ts — GCP Compute Engine agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { downloadFile, runServer, uploadFile } from "./gcp";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
