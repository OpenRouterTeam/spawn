// daytona/agents.ts — Daytona agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { runServer, uploadFile } from "./daytona";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
