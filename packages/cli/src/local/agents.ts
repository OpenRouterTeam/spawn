// local/agents.ts — Local machine agent configs (thin wrapper over shared)

import { runLocal, uploadFile } from "./local";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runLocal,
  uploadFile: async (l: string, r: string) => uploadFile(l, r),
});
