// local/local.ts — Core local provider: runs commands on the user's machine

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tryCatch } from "@openrouter/spawn-shared";
import { DOCKER_CONTAINER_NAME, DOCKER_REGISTRY } from "../shared/orchestrate.js";
import { getUserHome } from "../shared/paths.js";
import { getLocalShell } from "../shared/shell.js";
import { spawnInteractive } from "../shared/ssh.js";
import { logInfo, logStep } from "../shared/ui.js";

// ─── Validation ─────────────────────────────────────────────────────────────

/** Allowed pattern for agent names: lowercase alphanumeric and hyphens only. */
const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validate an agent name to prevent command injection in shell operations.
 * Agent names must match /^[a-z0-9-]+$/.
 */
export function validateAgentName(name: string): string {
  if (!name) {
    throw new Error("Invalid agent name: must not be empty");
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid agent name: must match [a-z0-9-]+, got: ${name}`);
  }
  return name;
}

/**
 * Validate a local file path to prevent path traversal attacks.
 * Rejects paths containing ".." segments after expansion.
 */
export function validateLocalPath(filePath: string): string {
  const home = getUserHome();
  // Expand ~ and $HOME before resolving
  const expanded = filePath.replace(/^\$HOME/, home).replace(/^~/, home);
  // Reject raw ".." before normalize (catches crafted paths)
  if (expanded.includes("..")) {
    throw new Error(`Invalid path: path traversal detected ("..") in: ${filePath}`);
  }
  const resolved = resolve(expanded);
  // Defense in depth: check resolved path for ".."
  if (resolved.includes("..")) {
    throw new Error(`Invalid path: path traversal detected ("..") in resolved: ${resolved}`);
  }
  return resolved;
}

// ─── Execution ───────────────────────────────────────────────────────────────

/** Validate a command string: must be non-empty and free of null bytes. */
function validateCommand(cmd: string): void {
  if (!cmd || cmd.includes("\0")) {
    throw new Error("Invalid command: must be non-empty and must not contain null bytes");
  }
}

/** Run a shell command locally and wait for it to finish. */
export async function runLocal(cmd: string): Promise<void> {
  validateCommand(cmd);
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

/** Run a command locally using an argument array (no shell interpretation). */
export async function runLocalArgs(args: ReadonlyArray<string>): Promise<void> {
  const proc = Bun.spawn(
    [
      ...args,
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
    throw new Error(`Command failed (exit ${exitCode}): ${args.join(" ")}`);
  }
}

// ─── File Operations ─────────────────────────────────────────────────────────

/** Copy a file locally, expanding ~ in the destination path. */
export function uploadFile(localPath: string, remotePath: string): void {
  const validated = validateLocalPath(remotePath);
  mkdirSync(dirname(validated), {
    recursive: true,
  });
  copyFileSync(localPath, validated);
}

/** Copy a file locally (reverse direction), expanding ~ and $HOME in the source path. */
export function downloadFile(remotePath: string, localPath: string): void {
  const validated = validateLocalPath(remotePath);
  mkdirSync(dirname(localPath), {
    recursive: true,
  });
  copyFileSync(validated, localPath);
}

// ─── Interactive Session ─────────────────────────────────────────────────────

/** Launch an interactive shell session locally. */
export async function interactiveSession(cmd: string): Promise<number> {
  validateCommand(cmd);
  const [shell, flag] = getLocalShell();
  return spawnInteractive([
    shell,
    flag,
    cmd,
  ]);
}

// ─── Docker Sandbox ─────────────────────────────────────────────────────────

/** Check whether the Docker daemon is running and responsive. */
export function isDockerAvailable(): boolean {
  return (
    Bun.spawnSync(
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
    ).exitCode === 0
  );
}

/** Check whether the docker binary exists (installed but daemon may be stopped). */
function isDockerInstalled(): boolean {
  return (
    Bun.spawnSync(
      [
        "which",
        "docker",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    ).exitCode === 0
  );
}

/** Check whether Homebrew is on PATH. */
function hasBrew(): boolean {
  return (
    Bun.spawnSync(
      [
        "which",
        "brew",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    ).exitCode === 0
  );
}

/**
 * Install OrbStack on macOS by downloading the official DMG over HTTPS,
 * mounting it, copying OrbStack.app into /Applications, and unmounting.
 *
 * Why: Homebrew may not be installed, and our previous fallback message
 * (`brew install orbstack`) would also fail on those machines. The DMG
 * is the same artifact OrbStack publishes for manual install.
 *
 * Returns true on success, false if any step fails (caller falls back
 * to printed instructions).
 */
function installOrbStackViaDmg(): boolean {
  // Pick the right architecture build. OrbStack labels Apple Silicon as
  // `arm64` and Intel as `amd64`.
  const uname = Bun.spawnSync([
    "uname",
    "-m",
  ]);
  const arch = uname.stdout.toString().trim() === "arm64" ? "arm64" : "amd64";
  const dmgUrl = `https://orbstack.dev/download/stable/latest/${arch}`;

  const tempDir = mkdtempSync(join(tmpdir(), "spawn-orbstack-"));
  const dmgPath = join(tempDir, "OrbStack.dmg");
  const mountPoint = join(tempDir, "mnt");
  let attached = false;

  // Wrap all the work; cleanup runs unconditionally afterwards.
  const work = tryCatch((): boolean => {
    logStep(`Downloading OrbStack (${arch})...`);
    const dl = Bun.spawnSync(
      [
        "curl",
        "-fsSL",
        "-o",
        dmgPath,
        dmgUrl,
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    if (dl.exitCode !== 0) {
      return false;
    }

    // Sanity-check: a real DMG is at least a few megabytes; any HTML error
    // page or truncated download will be tiny.
    if (statSync(dmgPath).size < 1_000_000) {
      return false;
    }

    logStep("Mounting OrbStack disk image...");
    mkdirSync(mountPoint, {
      recursive: true,
    });
    const attach = Bun.spawnSync(
      [
        "hdiutil",
        "attach",
        "-nobrowse",
        "-quiet",
        "-mountpoint",
        mountPoint,
        dmgPath,
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "inherit",
        ],
      },
    );
    if (attach.exitCode !== 0) {
      return false;
    }
    attached = true;

    logStep("Copying OrbStack.app to /Applications...");
    const cp = Bun.spawnSync(
      [
        "cp",
        "-R",
        join(mountPoint, "OrbStack.app"),
        "/Applications/",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "inherit",
        ],
      },
    );
    if (cp.exitCode !== 0) {
      return false;
    }

    // Clear the quarantine xattr — curl downloads have no Safari attribution
    // but some macOS versions still flag the unpacked .app. The user opted
    // in by running spawn, so remove it explicitly.
    Bun.spawnSync(
      [
        "xattr",
        "-dr",
        "com.apple.quarantine",
        "/Applications/OrbStack.app",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    );

    logInfo("OrbStack installed to /Applications/OrbStack.app");
    return true;
  });

  if (attached) {
    Bun.spawnSync(
      [
        "hdiutil",
        "detach",
        "-quiet",
        mountPoint,
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
  rmSync(tempDir, {
    recursive: true,
    force: true,
  });

  return work.ok && work.data === true;
}

/** Try to start the Docker daemon and wait up to 30s for it to respond. */
function startAndWaitForDocker(isMac: boolean): void {
  if (isMac) {
    logStep("Starting OrbStack...");
    Bun.spawnSync(
      [
        "open",
        "-a",
        "OrbStack",
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "ignore",
        ],
      },
    );
  } else {
    logStep("Starting Docker daemon...");
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
    if (hasSudo) {
      Bun.spawnSync(
        [
          "sudo",
          "systemctl",
          "start",
          "docker",
        ],
        {
          stdio: [
            "ignore",
            "inherit",
            "inherit",
          ],
        },
      );
    }
  }

  // Wait up to 30s for the daemon to be ready
  logStep("Waiting for Docker daemon...");
  for (let i = 0; i < 30; i++) {
    if (isDockerAvailable()) {
      logInfo("Docker is ready");
      return;
    }
    Bun.sleepSync(1000);
  }
  logInfo("Docker daemon did not start within 30s.");
  if (isMac) {
    logInfo("Open OrbStack.app manually, then retry.");
  }
  process.exit(1);
}

/** Ensure Docker is installed and the daemon is running. Installs and starts if needed. */
export async function ensureDocker(): Promise<void> {
  // Fast path: daemon already running
  if (isDockerAvailable()) {
    return;
  }

  const isMac = process.platform === "darwin";

  // Docker binary exists but daemon not running — just start it
  if (isDockerInstalled()) {
    startAndWaitForDocker(isMac);
    return;
  }

  // Not installed at all — install first
  if (isMac) {
    let installed = false;
    if (hasBrew()) {
      logStep("Docker not found — installing OrbStack via Homebrew...");
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
      installed = result.exitCode === 0;
    } else {
      logStep("Docker not found — installing OrbStack from orbstack.dev...");
      installed = installOrbStackViaDmg();
    }
    if (!installed) {
      logInfo("OrbStack auto-install failed. Install it manually from https://orbstack.dev/download");
      logInfo("(or, if you have Homebrew: brew install orbstack), then rerun this command.");
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

  // Start the daemon after fresh install
  startAndWaitForDocker(isMac);
}

/** Pull the agent Docker image and start a container. */
export async function pullAndStartContainer(agentName: string): Promise<void> {
  validateAgentName(agentName);

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
  await runLocalArgs([
    "docker",
    "pull",
    image,
  ]);

  logStep("Starting agent container...");
  await runLocalArgs([
    "docker",
    "run",
    "-d",
    "--name",
    DOCKER_CONTAINER_NAME,
    image,
  ]);
  logInfo("Agent container running");
}

/** Launch an interactive session inside the Docker container. */
export async function dockerInteractiveSession(cmd: string): Promise<number> {
  validateCommand(cmd);
  return spawnInteractive([
    "docker",
    "exec",
    "-it",
    DOCKER_CONTAINER_NAME,
    "bash",
    "-l",
    "-c",
    cmd,
  ]);
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
