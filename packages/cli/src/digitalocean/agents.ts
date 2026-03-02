// digitalocean/agents.ts — DigitalOcean agent configs (thin wrapper over shared)

import { runServer, uploadFile } from "./digitalocean";
import { createCloudAgents } from "../shared/agent-setup";

export const { agents, resolveAgent } = createCloudAgents({ runServer, uploadFile });
