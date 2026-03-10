// local/local.ts — Core local provider: runs commands on the user's machine

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnInteractive } from "../shared/ssh";
import { getUserHome } from "../shared/ui";

// ─── Execution ───────────────────────────────────────────────────────────────

/** Run a shell command locally and wait for it to finish. */
export async function runLocal(cmd: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      cmd,
    ],
    {
      stdio: [
        "inherit",
        "inherit",
        "inherit",
      ],
      env: process.env,
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${cmd}`);
  }
}

// ─── File Operations ─────────────────────────────────────────────────────────

/** Copy a file locally, expanding ~ in the destination path. */
export function uploadFile(localPath: string, remotePath: string): void {
  const expanded = remotePath.replace(/^~/, getUserHome());
  mkdirSync(dirname(expanded), {
    recursive: true,
  });
  copyFileSync(localPath, expanded);
}

// ─── Interactive Session ─────────────────────────────────────────────────────

/** Launch an interactive shell session locally. */
export async function interactiveSession(cmd: string): Promise<number> {
  return spawnInteractive([
    "bash",
    "-c",
    cmd,
  ]);
}
