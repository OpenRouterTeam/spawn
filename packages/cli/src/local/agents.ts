// local/agents.ts — Local machine agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFile, runLocal, uploadFile } from "./local.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runLocal,
  uploadFile: async (l: string, r: string) => uploadFile(l, r),
  downloadFile: async (r: string, l: string) => downloadFile(r, l),
});
