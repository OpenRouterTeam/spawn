// sprite/agents.ts — Sprite agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup.js";
import { downloadFileSprite, runSprite, uploadFileSprite } from "./sprite.js";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runSprite,
  uploadFile: uploadFileSprite,
  downloadFile: downloadFileSprite,
});
