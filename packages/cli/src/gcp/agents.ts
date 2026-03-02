// gcp/agents.ts — GCP Compute Engine agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./gcp";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
