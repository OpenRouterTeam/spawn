#!/usr/bin/env bun

// daytona/e2e.ts — QA helper for Daytona E2E shell drivers

import { getErrorMessage } from "@openrouter/spawn-shared";
import { destroyServer, getDaytonaClient, runDaytonaCommand } from "./daytona.js";

async function getRequiredClient() {
  const client = await getDaytonaClient(false);
  if (!client) {
    throw new Error("Daytona credentials are not available");
  }
  return client;
}

async function listAllSandboxes() {
  const client = await getRequiredClient();
  const sandboxes: Awaited<ReturnType<typeof client.list>>["items"] = [];
  let page = 1;

  for (;;) {
    const response = await client.list(undefined, page, 100);
    sandboxes.push(...response.items);
    if (response.items.length < 100) {
      return sandboxes;
    }
    page += 1;
  }
}

async function validateCredentials(): Promise<void> {
  const client = await getRequiredClient();
  await client.list(undefined, 1, 1);
}

async function findByName(name: string): Promise<void> {
  const sandbox = (await listAllSandboxes()).find((entry) => entry.name === name);
  if (!sandbox) {
    throw new Error(`Sandbox not found: ${name}`);
  }

  process.stdout.write(
    JSON.stringify({
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
    }),
  );
}

async function cleanupStale(prefix: string, maxAgeSeconds: number): Promise<void> {
  const client = await getRequiredClient();
  const now = Math.floor(Date.now() / 1000);

  for (const sandbox of await listAllSandboxes()) {
    if (!sandbox.name.startsWith(prefix)) {
      continue;
    }

    const timestamp = sandbox.name.split("-").pop() || "";
    if (!/^\d{10}$/.test(timestamp)) {
      continue;
    }

    const ageSeconds = now - Number.parseInt(timestamp, 10);
    if (ageSeconds <= maxAgeSeconds) {
      continue;
    }

    await client.delete(sandbox, 60);
  }
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "validate":
      await validateCredentials();
      return;
    case "find-by-name": {
      const name = process.argv[3];
      if (!name) {
        throw new Error("Usage: bun run daytona/e2e.ts find-by-name <name>");
      }
      await findByName(name);
      return;
    }
    case "exec": {
      const sandboxId = process.argv[3];
      const remoteCommand = process.argv[4];
      const timeoutRaw = process.argv[5];
      if (!sandboxId || remoteCommand === undefined) {
        throw new Error("Usage: bun run daytona/e2e.ts exec <sandbox-id> <command> [timeout-seconds]");
      }

      const timeoutSeconds = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
      const result = await runDaytonaCommand(sandboxId, remoteCommand, timeoutSeconds);
      if (result.output) {
        process.stdout.write(result.output);
      }
      process.exit(result.exitCode);
      return;
    }
    case "delete": {
      const sandboxId = process.argv[3];
      if (!sandboxId) {
        throw new Error("Usage: bun run daytona/e2e.ts delete <sandbox-id>");
      }
      await destroyServer(sandboxId);
      return;
    }
    case "cleanup-stale": {
      const prefix = process.argv[3] || "e2e-";
      const maxAgeSeconds = Number.parseInt(process.argv[4] || "1800", 10);
      await cleanupStale(prefix, maxAgeSeconds);
      return;
    }
    default:
      throw new Error("Usage: bun run daytona/e2e.ts <validate|find-by-name|exec|delete|cleanup-stale> [...]");
  }
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
