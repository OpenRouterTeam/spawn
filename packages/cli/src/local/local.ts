// local/local.ts — Core local provider: runs commands on the user's machine

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getUserHome } from "../shared/paths";
import { getLocalShell } from "../shared/shell";
import { spawnInteractive } from "../shared/ssh";

// ─── Execution ───────────────────────────────────────────────────────────────

/** Run a shell command locally and wait for it to finish. */
export async function runLocal(cmd: string): Promise<void> {
  const [shell, flag] = getLocalShell();
  const proc = Bun.spawn(
    [
      shell,
      flag,
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

/** Copy a file locally (reverse direction), expanding ~ and $HOME in the source path. */
export function downloadFile(remotePath: string, localPath: string): void {
  const expanded = remotePath.replace(/^\$HOME/, getUserHome()).replace(/^~/, getUserHome());
  mkdirSync(dirname(localPath), {
    recursive: true,
  });
  copyFileSync(expanded, localPath);
}

// ─── Interactive Session ─────────────────────────────────────────────────────

/** Launch an interactive shell session locally. */
export async function interactiveSession(cmd: string): Promise<number> {
  const [shell, flag] = getLocalShell();
  return spawnInteractive([
    shell,
    flag,
    cmd,
  ]);
}
