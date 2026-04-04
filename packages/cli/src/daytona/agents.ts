// daytona/agents.ts — Daytona agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runServer, uploadFile } from "./daytona.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer,
  uploadFile,
  downloadFile,
});
