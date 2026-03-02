// daytona/agents.ts — Daytona agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./daytona";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
});
