// sprite/sprite.ts — Core Sprite provider: CLI installation, auth, provisioning, execution

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  validateServerName,
  toKebabCase,
  defaultSpawnName,
} from "../shared/ui";

// ─── Configurable Constants ──────────────────────────────────────────────────

const CONNECTIVITY_POLL_DELAY = Number.parseInt(process.env.SPRITE_CONNECTIVITY_POLL_DELAY || "5", 10);

// ─── State ───────────────────────────────────────────────────────────────────

let spriteName = "";
let spriteOrg = "";

export function getState() {
  return {
    spriteName,
    spriteOrg,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);

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
    `${process.env.HOME}/.local/bin/sprite`,
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
      "curl -fsSL https://sprites.dev/install.sh | bash",
    ],
    {
      stdio: [
        "ignore",
        "inherit",
        "pipe",
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
  const localBin = `${process.env.HOME}/.local/bin`;
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
    spriteOrg = process.env.SPRITE_ORG;
    return;
  }
  const match = output.match(/Currently selected org: (\S+)/);
  if (match) {
    spriteOrg = match[1];
  }
}

function orgFlags(): string[] {
  if (spriteOrg) {
    return [
      "-o",
      spriteOrg,
    ];
  }
  return [];
}

// ─── Server Name ─────────────────────────────────────────────────────────────

export async function promptSpawnName(): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) {
    return;
  }

  let kebab: string;
  if (process.env.SPAWN_NAME) {
    kebab = toKebabCase(process.env.SPAWN_NAME) || defaultSpawnName();
  } else if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    kebab = defaultSpawnName();
  } else {
    const fallback = defaultSpawnName();
    process.stderr.write("\n");
    const answer = await prompt(`Sprite name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

export async function getServerName(): Promise<string> {
  if (process.env.SPRITE_NAME) {
    const name = process.env.SPRITE_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid SPRITE_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using sprite name from environment: ${name}`);
    return name;
  }

  const kebab = process.env.SPAWN_NAME_KEBAB || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  return kebab || defaultSpawnName();
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
        spriteName = name;
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
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to create sprite '${name}': ${stderr}`);
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
          spriteName = name;
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
      spriteName,
      "--",
      "echo",
      "ok",
    ]);
    if (proc.exitCode === 0) {
      logInfo(`Sprite '${spriteName}' is ready`);
      return;
    }
    logStep(`Sprite not ready, retrying (${attempt}/${maxAttempts})...`);
    await sleep(CONNECTIVITY_POLL_DELAY * 1000);
  }

  logError(`Sprite '${spriteName}' failed to respond after ${maxAttempts} attempts`);
  logError("Try: sprite list, sprite logs, or recreate the sprite");
  throw new Error("Sprite connectivity timeout");
}

// ─── Shell Environment Setup ─────────────────────────────────────────────────

export async function setupShellEnvironment(): Promise<void> {
  logStep("Configuring shell environment...");

  // Clean up stale 'exec zsh' from prior runs
  await runSpriteSilent(`sed -i '/exec \\/usr\\/bin\\/zsh/d' ~/.bashrc ~/.bash_profile 2>/dev/null; true`);

  // Upload and append PATH config to .bashrc and .zshrc
  const pathConfig = `\n# [spawn:path]\nexport PATH="\${HOME}/.bun/bin:/.sprite/languages/bun/bin:\${PATH}"\n`;
  const pathB64 = Buffer.from(pathConfig).toString("base64");
  await runSprite(
    `printf '%s' '${pathB64}' | base64 -d >> ~/.bashrc && printf '%s' '${pathB64}' | base64 -d >> ~/.zshrc`,
  );

  // Switch bash to zsh if available
  try {
    await runSpriteSilent("command -v zsh");
    const bashConfig = "# [spawn:bash]\nexec /usr/bin/zsh -l\n";
    const bashB64 = Buffer.from(bashConfig).toString("base64");
    await runSprite(
      `printf '%s' '${bashB64}' | base64 -d > ~/.bash_profile && printf '%s' '${bashB64}' | base64 -d > ~/.bashrc`,
    );
  } catch {
    logWarn("zsh not available on sprite, keeping bash as default shell");
  }
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

export function saveVmConnection(): void {
  const dir = `${process.env.HOME}/.spawn`;
  mkdirSync(dir, {
    recursive: true,
  });
  const json: Record<string, string> = {
    ip: "sprite-console",
    user: process.env.USER || "root",
    server_name: spriteName,
    cloud: "sprite",
  };
  writeFileSync(`${dir}/last-connection.json`, JSON.stringify(json) + "\n");
}

export function saveLaunchCmd(launchCmd: string): void {
  const connFile = `${process.env.HOME}/.spawn/last-connection.json`;
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    writeFileSync(connFile, JSON.stringify(data) + "\n");
  } catch {
    // Connection file may not exist — non-fatal
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Run a command on the remote sprite. Retries on transient errors.
 */
export async function runSprite(cmd: string): Promise<void> {
  const spriteCmd = getSpriteCmd()!;
  await spriteRetry("sprite exec", async () => {
    const proc = Bun.spawn(
      [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        spriteName,
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
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`sprite exec failed (exit ${exitCode}): ${cmd.slice(0, 80)}`);
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
      spriteName,
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
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`sprite exec (silent) failed (exit ${exitCode})`);
  }
}

/**
 * Upload a local file to the remote sprite using sprite exec -file flag.
 * The -file flag format is "localpath:remotepath".
 */
export async function uploadFileSprite(localPath: string, remotePath: string): Promise<void> {
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath) || remotePath.includes("..")) {
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
        spriteName,
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
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`upload failed for ${remotePath}: ${stderr}`);
    }
  });
}

/**
 * Launch an interactive session on the sprite.
 * Uses -tty for interactive mode, plain exec when SPAWN_PROMPT is set.
 */
export async function interactiveSession(cmd: string): Promise<number> {
  const spriteCmd = getSpriteCmd()!;

  const args = process.env.SPAWN_PROMPT
    ? [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        spriteName,
        "--",
        "bash",
        "-c",
        cmd,
      ]
    : [
        spriteCmd,
        ...orgFlags(),
        "exec",
        "-s",
        spriteName,
        "-tty",
        "--",
        "bash",
        "-c",
        cmd,
      ];

  const proc = Bun.spawn(args, {
    stdio: [
      "inherit",
      "inherit",
      "inherit",
    ],
  });
  const exitCode = await proc.exited;

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your sprite '${spriteName}' is still running.`);
  logWarn("Remember to destroy it when you're done to avoid ongoing charges.");
  logWarn("");
  logInfo("To destroy:");
  logInfo(`  sprite destroy ${spriteName}`);
  logInfo("To reconnect:");
  logInfo(`  sprite console -s ${spriteName}`);

  return exitCode;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(name?: string): Promise<void> {
  const target = name || spriteName;
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
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logError(`Failed to destroy sprite '${target}'`);
    logError(`Delete it manually: sprite destroy ${target}`);
    throw new Error("Sprite destruction failed");
  }

  logInfo(`Sprite '${target}' destroyed`);
}
