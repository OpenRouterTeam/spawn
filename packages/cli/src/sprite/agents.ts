// sprite/agents.ts — Sprite agent configs (thin wrapper over shared)

import { runSprite, uploadFileSprite } from "./sprite";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runSprite,
  uploadFile: uploadFileSprite,
});
