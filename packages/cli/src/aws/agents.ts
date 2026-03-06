// aws/agents.ts — AWS Lightsail agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { runServer, uploadFile } from "./aws";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
