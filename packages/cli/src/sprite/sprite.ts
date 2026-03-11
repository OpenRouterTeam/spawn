// sprite/sprite.ts — Core Sprite provider: CLI installation, auth, provisioning, execution

import type { VMConnection } from "../history.js";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getUserHome } from "../shared/paths";
import { asyncTryCatch } from "../shared/result.js";
import { killWithTimeout, sleep, spawnInteractive } from "../shared/ssh";
import { getErrorMessage } from "../shared/type-guards";
import {
  getServerNameFromEnv,
  logError,
  logInfo,
  logStep,
  logStepDone,
  logStepInline,
  logWarn,
  promptSpawnNameShared,
} from "../shared/ui";

// ─── Configurable Constants ──────────────────────────────────────────────────

const CONNECTIVITY_POLL_DELAY = Number.parseInt(process.env.SPRITE_CONNECTIVITY_POLL_DELAY || "5", 10);

// ─── State ───────────────────────────────────────────────────────────────────

interface SpriteState {
  name: string;
  org: string;
}

const _state: SpriteState = {
  name: "",
  org: "",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command locally and return { exitCode, stdout, stderr }. */
function spawnSync(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync(args, {
    stdio: [
      "ignore",
      "pipe",
      "pipe",
    ],
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

// ─── Retry Wrapper ───────────────────────────────────────────────────────────

/**
 * Retry wrapper for transient Sprite CLI errors (TLS timeouts, connection resets, etc.)
 * Retries up to 3 times with 3s backoff for known transient errors.
 */
async function spriteRetry<T>(desc: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await asyncTryCatch(fn);
    if (result.ok) {
      return result.data;
    }

    lastError = result.error;
    const msg = getErrorMessage(result.error);

    if (attempt >= maxRetries) {
      break;
    }

    // Only retry on transient network errors
    if (/TLS handshake timeout|connection closed|connection reset|connection refused/i.test(msg)) {
      logWarn(`${desc}: Transient error, retrying (${attempt}/${maxRetries})...`);
      await sleep(3000);
      continue;
    }

    // Non-transient error — don't retry
    break;
  }
  throw lastError;
}

// ─── Sprite CLI Detection ────────────────────────────────────────────────────

function getSpriteCmd(): string | null {
  if (
    Bun.spawnSync(
      [
        "which",
        "sprite",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
      },
    ).exitCode === 0
  ) {
    return "sprite";
  }
  const commonPaths = [
    join(getUserHome(), ".local/bin/sprite"),
    "/data/data/com.termux/files/usr/bin/sprite",
    "/usr/local/bin/sprite",
    "/usr/bin/sprite",
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

// ─── Sprite CLI Installation ─────────────────────────────────────────────────

export async function ensureSpriteCli(): Promise<void> {
  const cmd = getSpriteCmd();
  if (cmd) {
    // Log version if available
    const { stdout } = spawnSync([
      cmd,
      "version",
    ]);
    const ver = stdout.match(/v?\d+\.\d+\.\d+(-rc\d+)?/)?.[0];
    if (ver) {
      logInfo(`sprite ${ver} already installed`);
    } else {
      logInfo("sprite already installed");
    }
    return;
  }

  logStep("Installing sprite CLI...");
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      "curl --proto '=https' -fsSL https://sprites.dev/install.sh | bash",
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "inherit",
      ],
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logError("Failed to install sprite CLI");
    logError("Manual installation: visit https://sprites.dev for instructions");
    logError("Or try: curl -fsSL https://sprites.dev/install.sh | bash");
    throw new Error("Sprite CLI install failed");
  }

  // Add to PATH
  const localBin = join(getUserHome(), ".local/bin");
  if (!process.env.PATH?.includes(localBin)) {
    process.env.PATH = `${localBin}:${process.env.PATH}`;
  }

  if (!getSpriteCmd()) {
    logError("Sprite CLI installation completed but command not found in PATH");
    logError(`Try adding to PATH: export PATH="$HOME/.local/bin:$PATH"`);
    throw new Error("sprite not in PATH");
  }
  logInfo("Sprite CLI installed");
}

// ─── Authentication ──────────────────────────────────────────────────────────

export async function ensureSpriteAuthenticated(): Promise<void> {
  const cmd = getSpriteCmd()!;

  // Check if already authenticated
  const check = spawnSync([
    cmd,
    "org",
    "list",
  ]);
  if (check.exitCode === 0) {
    logInfo("Already authenticated with Sprite");
    detectOrg(check.stdout);
    return;
  }

  logStep("Logging in to Sprite...");
  const proc = Bun.spawn(
    [
      cmd,
      "login",
    ],
    {
      stdio: [
        "inherit",
        "inherit",
        "inherit",
      ],
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logError("Sprite login failed");
    logError("Try running 'sprite login' manually and follow the prompts");
    throw new Error("Sprite login failed");
  }

  // Verify login succeeded
  const verify = spawnSync([
    cmd,
    "org",
    "list",
  ]);
  if (verify.exitCode !== 0) {
    logError("Sprite login completed but authentication check still fails");
    logError("Try running 'sprite login' manually");
    throw new Error("Sprite auth verification failed");
  }

  detectOrg(verify.stdout);
  logInfo("Sprite authentication successful");
}

function detectOrg(output: string): void {
  if (process.env.SPRITE_ORG) {
    _state.org = process.env.SPRITE_ORG;
    return;
  }
  const match = output.match(/Currently selected org: (\S+)/);
  if (match) {
    _state.org = match[1];
  }
}

function orgFlags(): string[] {
  if (_state.org) {
    return [
      "-o",
      _state.org,
    ];
  }
  return [];
}

// ─── Server Name ─────────────────────────────────────────────────────────────

export async function promptSpawnName(): Promise<void> {
  return promptSpawnNameShared("Sprite");
}

export async function getServerName(): Promise<string> {
  return getServerNameFromEnv("SPRITE_NAME");
}

// ─── Provisioning ────────────────────────────────────────────────────────────

export async function createSprite(name: string): Promise<void> {
  const cmd = getSpriteCmd()!;

  // Check if sprite already exists
  const listResult = spawnSync([
    cmd,
    ...orgFlags(),
    "list",
  ]);
  if (listResult.exitCode === 0) {
    const lines = listResult.stdout.split("\n");
    for (const line of lines) {
      const firstToken = line.split(/\s/)[0];
      if (firstToken === name) {
        logInfo(`Sprite '${name}' already exists`);
        _state.name = name;
        return;
      }
    }
  }

  logStep(`Creating sprite '${name}'...`);
  await spriteRetry("sprite create", async () => {
    const proc = Bun.spawn(
      [
        cmd,
        ...orgFlags(),
        "create",
        "-skip-console",
        name,
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "pipe",
        ],
      },
    );
    // Drain stderr before awaiting exit to prevent pipe buffer deadlock
    const stderrText = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to create sprite '${name}': ${await stderrText}`);
    }
  });

  // Wait for sprite to appear in list
  logStep("Waiting for sprite to be provisioned...");
  const maxWait = 30;
  let elapsed = 0;
  while (elapsed < maxWait) {
    const check = spawnSync([
      cmd,
      ...orgFlags(),
      "list",
    ]);
    if (check.exitCode === 0) {
      const lines = check.stdout.split("\n");
      for (const line of lines) {
        const firstToken = line.split(/\s/)[0];
        if (firstToken === name) {
          logInfo(`Sprite '${name}' provisioned`);
          _state.name = name;
          return;
        }
      }
    }
    await sleep(2000);
    elapsed += 2;
  }

  logError(`Sprite '${name}' not found after ${maxWait}s`);
  throw new Error("Sprite provisioning timeout");
}

export async function verifySpriteConnectivity(maxAttempts = 6): Promise<void> {
  const cmd = getSpriteCmd()!;

  logStep("Verifying sprite connectivity...");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proc = spawnSync([
      cmd,
      ...orgFlags(),
      "exec",
      "-s",
      _state.name,
      "--",
      "echo",
      "ok",
    ]);
    if (proc.exitCode === 0) {
      logStepDone();
      logInfo(`Sprite '${_state.name}' is ready`);
      return;
    }
    logStepInline(`Sprite not ready, retrying (${attempt}/${maxAttempts})...`);
    await sleep(CONNECTIVITY_POLL_DELAY * 1000);
  }

  logStepDone();
  logError(`Sprite '${_state.name}' failed to respond after ${maxAttempts} attempts`);
  logError("Try: sprite list, sprite logs, or recreate the sprite");
  throw new Error("Sprite connectivity timeout");
}

// ─── Shell Environment Setup ─────────────────────────────────────────────────

export async function setupShellEnvironment(): Promise<void> {
  logStep("Configuring shell environment...");

  // Clean up stale 'exec zsh' from prior runs
  await runSpriteSilent(`sed -i '/exec \\/usr\\/bin\\/zsh/d' ~/.bashrc ~/.bash_profile 2>/dev/null; true`);

  // Upload and append PATH config to .bashrc and .zshrc
  const pathConfig = `\n# [spawn:path]\nexport PATH="\${HOME}/.npm-global/bin:\${HOME}/.local/bin:\${HOME}/.bun/bin:/.sprite/languages/bun/bin:\${PATH}"\n`;
  const pathB64 = Buffer.from(pathConfig).toString("base64");
  await runSprite(
    `printf '%s' '${pathB64}' | base64 -d >> ~/.bashrc && printf '%s' '${pathB64}' | base64 -d >> ~/.zshrc`,
  );

  // Switch interactive login shells to zsh (if available).
  // Only modify .bash_profile — NOT .bashrc — so non-interactive bash
  // (e.g., `sprite exec ... bash -c CMD`) still works and sources PATH config.
  const zshResult = await asyncTryCatch(async () => runSpriteSilent("command -v zsh"));
  if (zshResult.ok) {
    const bashProfile = "# [spawn:bash]\nexec /usr/bin/zsh -l\n";
    const bpB64 = Buffer.from(bashProfile).toString("base64");
    await runSprite(`printf '%s' '${bpB64}' | base64 -d > ~/.bash_profile`);
  } else {
    logWarn("zsh not available on sprite, keeping bash as default shell");
  }
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

export function getVmConnection(): VMConnection {
  return {
    ip: "sprite-console",
    user: process.env.USER || "root",
    server_name: _state.name,
    cloud: "sprite",
  };
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Run a command on the remote sprite. Retries on transient errors.
 */
export async function runSprite(cmd: string, timeoutSecs?: number): Promise<void> {
  const spriteCmd = getSpriteCmd()!;
  await spriteRetry("sprite exec", async () => {
    const proc = Bun.spawn(
      [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        _state.name,
        "--",
        "bash",
        "-c",
        cmd,
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "inherit",
        ],
      },
    );
    const timeout = (timeoutSecs || 300) * 1000;
    const timer = setTimeout(() => killWithTimeout(proc), timeout);
    try {
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`sprite exec failed (exit ${exitCode}): ${cmd.slice(0, 80)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Run a command silently (no stdout/stderr). Throws on failure. */
async function runSpriteSilent(cmd: string): Promise<void> {
  const spriteCmd = getSpriteCmd()!;
  const proc = Bun.spawn(
    [
      spriteCmd,
      ...orgFlags(),
      "exec",
      "-s",
      _state.name,
      "--",
      "bash",
      "-c",
      cmd,
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "ignore",
      ],
    },
  );
  // 60s timeout — silent commands should not hang indefinitely
  const timer = setTimeout(() => killWithTimeout(proc), 60_000);
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`sprite exec (silent) failed (exit ${exitCode})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload a local file to the remote sprite using sprite exec -file flag.
 * The -file flag format is "localpath:remotepath".
 */
export async function uploadFileSprite(localPath: string, remotePath: string): Promise<void> {
  if (
    !/^[a-zA-Z0-9/_.~-]+$/.test(remotePath) ||
    remotePath.includes("..") ||
    remotePath.split("/").some((s) => s.startsWith("-"))
  ) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }

  const spriteCmd = getSpriteCmd()!;
  // Generate a random temp path on remote to prevent symlink attacks
  const tempRandom = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const basename = remotePath.split("/").pop() || "file";
  const tempRemote = `/tmp/sprite_upload_${basename}_${tempRandom}`;

  await spriteRetry("sprite upload", async () => {
    const proc = Bun.spawn(
      [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        _state.name,
        "-file",
        `${localPath}:${tempRemote}`,
        "--",
        "bash",
        "-c",
        `mkdir -p $(dirname '${remotePath}') && mv '${tempRemote}' '${remotePath}'`,
      ],
      {
        stdio: [
          "ignore",
          "inherit",
          "pipe",
        ],
      },
    );
    // Drain stderr before awaiting exit to prevent pipe buffer deadlock
    const stderrText = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`upload failed for ${remotePath}: ${await stderrText}`);
    }
  });
}

// ─── Keep-Alive ───────────────────────────────────────────────────────────────

/**
 * Download and install sprite-keep-running on the remote sprite.
 * This script wraps a command and keeps the sprite alive (via Sprite's /v1/tasks API)
 * as long as the agent is running — preventing inactivity shutdown.
 *
 * Non-fatal: logs a warning if download fails so deployment still proceeds.
 * Reference: https://kurt-claw-f.sprites.app/sprite-keep-running.sh
 */
export async function installSpriteKeepAlive(): Promise<void> {
  logStep("Installing Sprite keep-alive...");
  const scriptUrl = "https://kurt-claw-f.sprites.app/sprite-keep-running.sh";
  const r = await asyncTryCatch(async () => {
    await runSprite(
      "mkdir -p ~/.local/bin && " +
        `curl -fsSL '${scriptUrl}' -o ~/.local/bin/sprite-keep-running && ` +
        "chmod +x ~/.local/bin/sprite-keep-running",
      60,
    );
  });
  if (r.ok) {
    logInfo("Sprite keep-alive installed");
  } else {
    logWarn("Could not install Sprite keep-alive — sprite may shut down during inactivity");
  }
}

/**
 * Launch an interactive session on the sprite.
 * Uses -tty for interactive mode, plain exec when SPAWN_PROMPT is set.
 *
 * The session command is base64-encoded and written to a temp file to avoid
 * quoting issues with multi-line restart loop scripts. If sprite-keep-running
 * is installed, it wraps the command to keep the sprite alive via Sprite's
 * /v1/tasks API for the duration of the session.
 */
export async function interactiveSession(cmd: string): Promise<number> {
  const spriteCmd = getSpriteCmd()!;

  // Encode the session command to handle multi-line restart loop scripts safely
  const cmdB64 = Buffer.from(cmd).toString("base64");

  // Write cmd to a temp file and exec with keep-alive wrapper if available
  const sessionScript = [
    "_f=$(mktemp /tmp/spawn_XXXXXX.sh)",
    `printf '%s' '${cmdB64}' | base64 -d > "$_f"`,
    'chmod +x "$_f"',
    "trap 'rm -f \"$_f\"' EXIT INT TERM",
    "if command -v sprite-keep-running >/dev/null 2>&1; then",
    '  sprite-keep-running bash "$_f"',
    "else",
    '  bash "$_f"',
    "fi",
  ].join("\n");

  const args = process.env.SPAWN_PROMPT
    ? [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        _state.name,
        "--",
        "bash",
        "-c",
        sessionScript,
      ]
    : [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        _state.name,
        "-tty",
        "--",
        "bash",
        "-c",
        sessionScript,
      ];

  const exitCode = spawnInteractive(args);

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your sprite '${_state.name}' is still running.`);
  logWarn("Remember to destroy it when you're done to avoid ongoing charges.");
  logWarn("");
  logInfo("To destroy:");
  logInfo(`  sprite destroy ${_state.name}`);
  logInfo("To reconnect:");
  logInfo(`  sprite console -s ${_state.name}`);

  return exitCode;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(name?: string): Promise<void> {
  const target = name || _state.name;
  if (!target) {
    logError("destroy_server: no sprite name provided");
    throw new Error("No sprite name");
  }

  const cmd = getSpriteCmd()!;
  logStep(`Destroying sprite '${target}'...`);

  const proc = Bun.spawn(
    [
      cmd,
      ...orgFlags(),
      "destroy",
      "--force",
      target,
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "pipe",
      ],
    },
  );
  // Drain stderr before awaiting exit to prevent pipe buffer deadlock
  const stderrText = new Response(proc.stderr).text();
  // 60s timeout — sprite destroy should not hang indefinitely
  const timer = setTimeout(() => killWithTimeout(proc), 60_000);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0) {
    logError(`Failed to destroy sprite '${target}'`);
    logError(`Delete it manually: sprite destroy ${target}`);
    throw new Error(`Sprite destruction failed: ${await stderrText}`);
  }

  logInfo(`Sprite '${target}' destroyed`);
}
