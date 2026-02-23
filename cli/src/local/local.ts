// local/local.ts — Core local provider: runs commands on the user's machine

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

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

/** Run a shell command locally and capture stdout. */
export async function runLocalCapture(cmd: string): Promise<string> {
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      cmd,
    ],
    {
      stdio: [
        "inherit",
        "pipe",
        "inherit",
      ],
      env: process.env,
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (exit ${exitCode}): ${cmd}`);
  }
  return stdout.trim();
}

// ─── File Operations ─────────────────────────────────────────────────────────

/** Copy a file locally, expanding ~ in the destination path. */
export function uploadFile(localPath: string, remotePath: string): void {
  const expanded = remotePath.replace(/^~/, process.env.HOME || "");
  mkdirSync(dirname(expanded), {
    recursive: true,
  });
  copyFileSync(localPath, expanded);
}

// ─── Interactive Session ─────────────────────────────────────────────────────

/** Launch an interactive shell session locally. */
export async function interactiveSession(cmd: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("bash", ["-c", cmd], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

export function saveLocalConnection(): void {
  const dir = `${process.env.HOME}/.spawn`;
  mkdirSync(dir, {
    recursive: true,
  });
  const hostname = Bun.spawnSync(
    [
      "hostname",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "ignore",
      ],
    },
  );
  const name = new TextDecoder().decode(hostname.stdout).trim() || "local";
  const user = process.env.USER || "unknown";
  const json = JSON.stringify({
    ip: "localhost",
    user,
    server_name: name,
    cloud: "local",
  });
  Bun.write(`${dir}/last-connection.json`, json + "\n");
}

/** Save launch command to the last-connection.json file. */
export function saveLaunchCmd(launchCmd: string): void {
  const connFile = `${process.env.HOME}/.spawn/last-connection.json`;
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    Bun.write(connFile, JSON.stringify(data) + "\n");
  } catch {
    // non-fatal
  }
}
