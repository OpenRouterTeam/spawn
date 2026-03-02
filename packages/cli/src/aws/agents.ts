// aws/agents.ts — AWS Lightsail agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./aws";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
