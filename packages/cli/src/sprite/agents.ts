// sprite/agents.ts — Sprite agent configs (thin wrapper over shared)

import { createCloudAgents } from "../shared/agent-setup";
import { runSprite, uploadFileSprite } from "./sprite";

export const { agents, resolveAgent } = createCloudAgents({
  runServer: runSprite,
  uploadFile: uploadFileSprite,
});
