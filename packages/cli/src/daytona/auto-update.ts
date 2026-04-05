// daytona/auto-update.ts — Daytona reconnect helpers for auto-update sessions

import type { VMConnection } from "../history.js";

import { getErrorMessage } from "@openrouter/spawn-shared";
import { logWarn } from "../shared/ui.js";
import { resolveAgent } from "./agents.js";
import { setupAutoUpdateSessionForSandbox } from "./daytona.js";

/**
 * Re-arm Daytona auto-update when the saved record says it was enabled at spawn time.
 */
export async function ensureDaytonaAutoUpdate(connection: VMConnection, agentKey: string): Promise<void> {
  if (connection.cloud !== "daytona") {
    return;
  }

  if (connection.metadata?.auto_update_enabled !== "1") {
    return;
  }

  if (!connection.server_id) {
    throw new Error("Daytona connection is missing server_id");
  }

  try {
    const agent = resolveAgent(agentKey);
    if (!agent.updateCmd) {
      return;
    }
    await setupAutoUpdateSessionForSandbox(connection.server_id, agent.name, agent.updateCmd, true);
  } catch (error: unknown) {
    logWarn(`Could not re-arm Daytona auto-update: ${getErrorMessage(error)}`);
  }
}
