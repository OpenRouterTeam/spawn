// local/local.ts — Core local provider: runs commands on the user's machine

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DOCKER_CONTAINER_NAME, DOCKER_REGISTRY } from "../shared/orchestrate.js";
import { getUserHome } from "../shared/paths.js";
import { getLocalShell } from "../shared/shell.js";
import { spawnInteractive } from "../shared/ssh.js";
import { logInfo, logStep } from "../shared/ui.js";

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

// ─── Docker Sandbox ─────────────────────────────────────────────────────────

/** Check whether Docker (or OrbStack) is available on the host. */
export function isDockerAvailable(): boolean {
  const result = Bun.spawnSync(
    [
      "docker",
      "info",
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "ignore",
      ],
    },
  );
  return result.exitCode === 0;
}

/** Install Docker if not present, or exit with guidance if install fails. */
export async function ensureDocker(): Promise<void> {
  if (isDockerAvailable()) {
    return;
  }

  const isMac = process.platform === "darwin";
  if (isMac) {
    logStep("Docker not found — installing OrbStack...");
    const result = Bun.spawnSync(
      [
        "brew",
        "install",
        "orbstack",
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if (result.exitCode !== 0) {
      logInfo("Auto-install failed. Install OrbStack manually: brew install orbstack");
      process.exit(1);
    }
  } else {
    logStep("Docker not found — installing docker.io...");
    const hasSudo =
      Bun.spawnSync(
        [
          "which",
          "sudo",
        ],
        {
          stdio: [
            "ignore",
            "ignore",
            "ignore",
          ],
        },
      ).exitCode === 0;
    const prefix = hasSudo ? "sudo " : "";
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `${prefix}apt-get update -qq && ${prefix}apt-get install -y -qq docker.io`,
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if (result.exitCode !== 0) {
      logInfo("Auto-install failed. Install Docker manually: sudo apt-get install docker.io");
      process.exit(1);
    }
  }

  // Verify Docker works after install
  if (!isDockerAvailable()) {
    logInfo("Docker installed but not responding. You may need to start the Docker daemon.");
    process.exit(1);
  }
}

/** Pull the agent Docker image and start a container. */
export async function pullAndStartContainer(agentName: string): Promise<void> {
  // Clean up any stale container (ignore errors)
  Bun.spawnSync(
    [
      "docker",
      "rm",
      "-f",
      DOCKER_CONTAINER_NAME,
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "ignore",
      ],
    },
  );

  const image = `${DOCKER_REGISTRY}/spawn-${agentName}:latest`;
  logStep(`Pulling Docker image ${image}...`);
  await runLocal(`docker pull ${image}`);

  logStep("Starting agent container...");
  await runLocal(`docker run -d --name ${DOCKER_CONTAINER_NAME} ${image}`);
  logInfo("Agent container running");
}

/** Launch an interactive session inside the Docker container. */
export function dockerInteractiveSession(cmd: string): Promise<number> {
  return Promise.resolve(
    spawnInteractive([
      "docker",
      "exec",
      "-it",
      DOCKER_CONTAINER_NAME,
      "bash",
      "-l",
      "-c",
      cmd,
    ]),
  );
}

/** Remove the sandbox container (best-effort, for cleanup). */
export function cleanupContainer(): void {
  Bun.spawnSync(
    [
      "docker",
      "rm",
      "-f",
      DOCKER_CONTAINER_NAME,
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "ignore",
      ],
    },
  );
}
