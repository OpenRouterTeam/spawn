// local/agents.ts — Local machine agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { runLocal, uploadFile } from "./local";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runLocal,
  uploadFile: async (l: string, r: string) => uploadFile(l, r),
});
