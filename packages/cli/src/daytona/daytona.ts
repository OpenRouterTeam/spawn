// daytona/daytona.ts — Daytona SDK-backed provider and command helpers

import type { CloudInstance, VMConnection } from "../history.js";

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk";
import { isString } from "@openrouter/spawn-shared";
import * as v from "valibot";
import {
  validateConnectionIP,
  validateServerIdentifier,
  validateTunnelPort,
  validateTunnelUrl,
  validateUsername,
} from "../security.js";
import { parseJsonWith } from "../shared/parse.js";
import { getSpawnCloudConfigPath } from "../shared/paths.js";
import { asyncTryCatch } from "../shared/result.js";
import { SSH_INTERACTIVE_OPTS, validateRemotePath } from "../shared/ssh.js";
import {
  getServerNameFromEnv,
  jsonEscape,
  loadApiToken,
  logInfo,
  logStep,
  logWarn,
  prepareStdinForHandoff,
  prompt,
  promptSpawnNameShared,
  selectFromList,
  shellQuote,
  validateServerName,
} from "../shared/ui.js";

interface DaytonaConfigFile {
  api_key?: string;
  token?: string;
  api_url?: string;
  target?: string;
}

interface ResolvedDaytonaConfig {
  apiKey: string;
  apiUrl?: string;
  target?: string;
}

interface DaytonaSshAccess {
  host: string;
  port?: string;
  token: string;
}

export interface SandboxSize {
  id: string;
  cpu: number;
  memory: number;
  disk: number;
  label: string;
}

interface DaytonaState {
  client: Daytona | null;
  sandboxId: string;
  sandboxSize: SandboxSize;
  homeDir: string | null;
  workDir: string | null;
}

const DaytonaConfigFileSchema = v.object({
  api_key: v.optional(v.string()),
  token: v.optional(v.string()),
  api_url: v.optional(v.string()),
  target: v.optional(v.string()),
});

const DAYTONA_SSH_HOST = "ssh.app.daytona.io";
const DAYTONA_DASHBOARD_URL = "https://app.daytona.io/dashboard/sandboxes";
const DAYTONA_SIGNED_PREVIEW_DEFAULT_SECONDS = 3600;
const DAYTONA_AUTO_UPDATE_SESSION_ID = "spawn-auto-update";
const OPENCLAW_DASHBOARD_PORT = 18789;
const OPENCLAW_DASHBOARD_PAIR_LOG_PATH = "/tmp/openclaw-dashboard-pair.log";
const OPENCLAW_DASHBOARD_PAIR_POLL_ATTEMPTS = 45;
const OPENCLAW_DASHBOARD_PAIR_POLL_INTERVAL_SECONDS = 2;
const DAYTONA_ALLOWED_METADATA_KEYS = new Set([
  "auto_update_enabled",
  "tunnel_remote_port",
  "tunnel_browser_url_template",
]);

export const SANDBOX_SIZES: SandboxSize[] = [
  {
    id: "small",
    cpu: 2,
    memory: 4,
    disk: 30,
    label: "2 vCPU · 4 GiB RAM · 30 GiB disk",
  },
  {
    id: "medium",
    cpu: 4,
    memory: 8,
    disk: 50,
    label: "4 vCPU · 8 GiB RAM · 50 GiB disk",
  },
  {
    id: "large",
    cpu: 8,
    memory: 16,
    disk: 100,
    label: "8 vCPU · 16 GiB RAM · 100 GiB disk",
  },
];

const DEFAULT_SANDBOX_SIZE = SANDBOX_SIZES[0];

const _state: DaytonaState = {
  client: null,
  sandboxId: "",
  sandboxSize: DEFAULT_SANDBOX_SIZE,
  homeDir: null,
  workDir: null,
};

/**
 * Reset provider state for test isolation.
 */
export function resetDaytonaState(): void {
  _state.client = null;
  _state.sandboxId = "";
  _state.sandboxSize = DEFAULT_SANDBOX_SIZE;
  _state.homeDir = null;
  _state.workDir = null;
}

function getDaytonaConfigPath(): string {
  return getSpawnCloudConfigPath("daytona");
}

async function readSavedDaytonaConfigSafe(): Promise<DaytonaConfigFile | null> {
  const configFile = Bun.file(getDaytonaConfigPath());
  if (!(await configFile.exists())) {
    return null;
  }
  const raw = await configFile.text();
  return parseJsonWith(raw, DaytonaConfigFileSchema);
}

function resolveConfiguredToken(saved: DaytonaConfigFile | null): string {
  const envToken = process.env.DAYTONA_API_KEY?.trim();
  if (envToken) {
    return envToken;
  }
  return loadApiToken("daytona") || saved?.api_key || saved?.token || "";
}

function resolveConfiguredApiUrl(saved: DaytonaConfigFile | null): string | undefined {
  return process.env.DAYTONA_API_URL || process.env.DAYTONA_SERVER_URL || saved?.api_url;
}

function resolveConfiguredTarget(saved: DaytonaConfigFile | null): string | undefined {
  return process.env.DAYTONA_TARGET || saved?.target;
}

function createDaytonaClient(config: ResolvedDaytonaConfig): Daytona {
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
  });
}

async function validateClient(client: Daytona): Promise<void> {
  await client.list(undefined, 1, 1);
}

async function saveDaytonaConfig(config: ResolvedDaytonaConfig): Promise<void> {
  const configPath = getDaytonaConfigPath();
  const dir = configPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });

  const lines = [
    "{",
    `  "api_key": ${jsonEscape(config.apiKey)},`,
    `  "token": ${jsonEscape(config.apiKey)}`,
  ];
  if (config.apiUrl) {
    lines[lines.length - 1] += ",";
    lines.push(`  "api_url": ${jsonEscape(config.apiUrl)}`);
  }
  if (config.target) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] += ",";
    lines.push(`  "target": ${jsonEscape(config.target)}`);
  }
  lines.push("}");

  writeFileSync(configPath, lines.join("\n") + "\n", {
    mode: 0o600,
  });
}

async function tryCreateConfiguredClient(): Promise<Daytona | null> {
  const savedConfig = await readSavedDaytonaConfigSafe();
  const apiKey = resolveConfiguredToken(savedConfig);
  if (!apiKey) {
    return null;
  }

  const client = createDaytonaClient({
    apiKey,
    apiUrl: resolveConfiguredApiUrl(savedConfig),
    target: resolveConfiguredTarget(savedConfig),
  });

  await validateClient(client);
  return client;
}

/**
 * Resolve a validated Daytona client, prompting for credentials only when explicitly allowed.
 */
export async function getDaytonaClient(allowPrompt = false): Promise<Daytona | null> {
  if (_state.client) {
    return _state.client;
  }

  const configuredClientResult = await asyncTryCatch(() => tryCreateConfiguredClient());
  const configuredClient = configuredClientResult.ok ? configuredClientResult.data : null;

  if (configuredClient) {
    _state.client = configuredClient;
    return configuredClient;
  }

  if (!allowPrompt) {
    return null;
  }

  logStep("Manual Daytona API key entry");
  logInfo("Get your Daytona API key from https://app.daytona.io/dashboard/keys");

  for (;;) {
    const token = (await prompt("Enter your Daytona API key: ")).trim();
    if (!token) {
      throw new Error("No Daytona API key provided");
    }

    const savedConfig = await readSavedDaytonaConfigSafe();
    const resolvedConfig: ResolvedDaytonaConfig = {
      apiKey: token,
      apiUrl: resolveConfiguredApiUrl(savedConfig),
      target: resolveConfiguredTarget(savedConfig),
    };

    const client = createDaytonaClient(resolvedConfig);
    const validation = await asyncTryCatch(async () => {
      await validateClient(client);
      await saveDaytonaConfig(resolvedConfig);
    });
    if (validation.ok) {
      _state.client = client;
      logInfo("Daytona API key validated and saved");
      return client;
    }

    logWarn(
      `Invalid Daytona API key: ${validation.error instanceof Error ? validation.error.message : "unknown error"}`,
    );
  }
}

/**
 * Ensure Daytona credentials are available for interactive commands.
 */
export async function ensureDaytonaAuthenticated(): Promise<void> {
  const client = await getDaytonaClient(true);
  if (!client) {
    throw new Error("Daytona authentication failed");
  }
}

function resolveSandboxSizeFromEnv(): SandboxSize | null {
  const cpu = process.env.DAYTONA_CPU;
  const memory = process.env.DAYTONA_MEMORY;
  const disk = process.env.DAYTONA_DISK;
  if (cpu || memory || disk) {
    const parsedCpu = Number.parseInt(cpu || String(DEFAULT_SANDBOX_SIZE.cpu), 10);
    const parsedMemory = Number.parseInt(memory || String(DEFAULT_SANDBOX_SIZE.memory), 10);
    const parsedDisk = Number.parseInt(disk || String(DEFAULT_SANDBOX_SIZE.disk), 10);
    if (!Number.isInteger(parsedCpu) || !Number.isInteger(parsedMemory) || !Number.isInteger(parsedDisk)) {
      throw new Error("DAYTONA_CPU, DAYTONA_MEMORY, and DAYTONA_DISK must be integers");
    }

    return {
      id: "custom",
      cpu: parsedCpu,
      memory: parsedMemory,
      disk: parsedDisk,
      label: `${parsedCpu} vCPU · ${parsedMemory} GiB RAM · ${parsedDisk} GiB disk`,
    };
  }

  const sizeId = process.env.DAYTONA_SANDBOX_SIZE;
  if (!sizeId) {
    return null;
  }

  const matched = SANDBOX_SIZES.find((size) => size.id === sizeId);
  if (!matched) {
    throw new Error(`Invalid DAYTONA_SANDBOX_SIZE: ${sizeId}`);
  }
  return matched;
}

/**
 * Prompt for a sandbox size or resolve one from environment variables.
 */
export async function promptSandboxSize(): Promise<SandboxSize> {
  const envSize = resolveSandboxSizeFromEnv();
  if (envSize) {
    _state.sandboxSize = envSize;
    return envSize;
  }

  if (process.env.SPAWN_CUSTOM !== "1" || process.env.SPAWN_NON_INTERACTIVE === "1") {
    _state.sandboxSize = DEFAULT_SANDBOX_SIZE;
    return DEFAULT_SANDBOX_SIZE;
  }

  process.stderr.write("\n");
  const selectedId = await selectFromList(
    SANDBOX_SIZES.map((size) => `${size.id}|${size.label}`),
    "Daytona sandbox size",
    DEFAULT_SANDBOX_SIZE.id,
  );
  const selected = SANDBOX_SIZES.find((size) => size.id === selectedId) || DEFAULT_SANDBOX_SIZE;
  _state.sandboxSize = selected;
  return selected;
}

/**
 * Prompt for the spawn name or derive it non-interactively.
 */
export async function promptSpawnName(): Promise<void> {
  await promptSpawnNameShared("Daytona sandbox");
}

/**
 * Resolve the Daytona sandbox name from environment or default spawn naming.
 */
export async function getServerName(): Promise<string> {
  return getServerNameFromEnv("DAYTONA_SANDBOX_NAME");
}

function getRequestedImage(): string {
  const image = process.env.DAYTONA_IMAGE || "daytonaio/sandbox:latest";
  if (!/^[a-zA-Z0-9./:_-]+$/.test(image)) {
    throw new Error(`Invalid DAYTONA_IMAGE: ${image}`);
  }
  return image;
}

function clearSandboxPathCache(sandboxId: string): void {
  if (_state.sandboxId !== sandboxId) {
    _state.homeDir = null;
    _state.workDir = null;
    _state.sandboxId = sandboxId;
  }
}

async function getRequiredClient(): Promise<Daytona> {
  const client = await getDaytonaClient(true);
  if (!client) {
    throw new Error("Daytona client not available");
  }
  return client;
}

async function getSandboxById(sandboxId: string) {
  const client = await getRequiredClient();
  const sandbox = await client.get(sandboxId);
  clearSandboxPathCache(sandbox.id);
  return sandbox;
}

function buildCreateLabels(): Record<string, string> {
  return {
    "managed-by": "spawn",
    cloud: "daytona",
  };
}

/**
 * Create a Daytona sandbox and return Spawn's persisted connection shape.
 */
export async function createServer(name: string): Promise<VMConnection> {
  if (!validateServerName(name)) {
    throw new Error(`Invalid Daytona sandbox name: ${name}`);
  }

  const client = await getRequiredClient();
  const size = _state.sandboxSize;
  const image = getRequestedImage();

  logStep(`Creating Daytona sandbox '${name}' (${size.label})...`);
  const sandbox = await client.create({
    name,
    image,
    resources: {
      cpu: size.cpu,
      memory: size.memory,
      disk: size.disk,
    },
    labels: buildCreateLabels(),
    autoStopInterval: 0,
    autoArchiveInterval: 0,
    autoDeleteInterval: -1,
  });

  clearSandboxPathCache(sandbox.id);
  logInfo(`Sandbox created: ${sandbox.id}`);

  return {
    ip: DAYTONA_SSH_HOST,
    user: sandbox.user || "daytona",
    server_id: sandbox.id,
    server_name: sandbox.name,
    cloud: "daytona",
  };
}

/**
 * Wait for the provider state to reference a started sandbox.
 */
export async function waitForReady(): Promise<void> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }
  const sandbox = await getSandboxById(_state.sandboxId);
  if (sandbox.state !== "started") {
    await sandbox.start(60);
  }
}

async function getSandboxHomeDir(sandboxId: string): Promise<string> {
  if (_state.homeDir) {
    return _state.homeDir;
  }
  const sandbox = await getSandboxById(sandboxId);
  const homeDir = await sandbox.getUserHomeDir();
  if (!homeDir) {
    throw new Error("Could not resolve Daytona sandbox home directory");
  }
  _state.homeDir = homeDir;
  return homeDir;
}

async function getSandboxWorkDir(sandboxId: string): Promise<string> {
  if (_state.workDir) {
    return _state.workDir;
  }
  const sandbox = await getSandboxById(sandboxId);
  const workDir = await sandbox.getWorkDir();
  if (!workDir) {
    const homeDir = await getSandboxHomeDir(sandboxId);
    _state.workDir = homeDir;
    return homeDir;
  }
  _state.workDir = workDir;
  return workDir;
}

async function resolveRemotePath(sandboxId: string, remotePath: string): Promise<string> {
  const homeDir = await getSandboxHomeDir(sandboxId);
  const workDir = await getSandboxWorkDir(sandboxId);

  let expanded = remotePath;
  if (remotePath === "~") {
    expanded = homeDir;
  } else if (remotePath.startsWith("~/")) {
    expanded = `${homeDir}/${remotePath.slice(2)}`;
  } else if (remotePath === "$HOME") {
    expanded = homeDir;
  } else if (remotePath.startsWith("$HOME/")) {
    expanded = `${homeDir}/${remotePath.slice(6)}`;
  } else if (!remotePath.startsWith("/")) {
    expanded = `${workDir}/${remotePath}`;
  }

  return validateRemotePath(expanded, /^[a-zA-Z0-9/_.~-]+$/);
}

function formatProcessCommand(cmd: string): string {
  if (!cmd || /\0/.test(cmd)) {
    throw new Error("Invalid command: must be non-empty and must not contain null bytes");
  }
  return `bash -lc ${shellQuote(cmd)}`;
}

function buildAutoUpdateScript(agentName: string, updateCmd: string): string {
  return [
    "#!/bin/bash",
    "set -eo pipefail",
    'LOGFILE="$HOME/.spawn-auto-update.log"',
    "",
    'log() { printf "[%s] %s\\n" "$(date -u +\'%Y-%m-%dT%H:%M:%SZ\')" "$*" >> "$LOGFILE"; }',
    "",
    '[ -f "$HOME/.spawnrc" ] && source "$HOME/.spawnrc" 2>/dev/null',
    'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.claude/local/bin:$PATH"',
    "",
    'log "Auto-update session started; first run in 15 minutes"',
    "sleep 900",
    "",
    "while true; do",
    '  [ -f "$HOME/.spawnrc" ] && source "$HOME/.spawnrc" 2>/dev/null',
    '  export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.claude/local/bin:$PATH"',
    "",
    '  log "Updating system packages"',
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    export DEBIAN_FRONTEND=noninteractive",
    `    sudo flock -w 300 /var/lib/dpkg/lock-frontend apt-get update -qq >> "$LOGFILE" 2>&1 || log "apt-get update failed (non-fatal)"`,
    `    sudo flock -w 300 /var/lib/dpkg/lock-frontend apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" >> "$LOGFILE" 2>&1 || log "apt-get upgrade failed (non-fatal)"`,
    '    sudo apt-get autoremove -y -qq >> "$LOGFILE" 2>&1 || true',
    '    log "System packages updated"',
    "  fi",
    "",
    `  log "Starting ${agentName} update"`,
    `  if ( ${updateCmd} ) >> "$LOGFILE" 2>&1; then`,
    `    log "${agentName} update completed successfully"`,
    "  else",
    "    _exit=$?",
    `    log "${agentName} update failed (exit code $_exit)"`,
    "  fi",
    "",
    '  log "Sleeping for 6 hours"',
    "  sleep 21600",
    "done",
    "",
  ].join("\n");
}

/**
 * Install and start Daytona auto-update as a background SDK process session.
 */
export async function setupAutoUpdateSession(agentName: string, updateCmd: string): Promise<void> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }

  await setupAutoUpdateSessionForSandbox(_state.sandboxId, agentName, updateCmd);
}

/**
 * Install and start Daytona auto-update as a background SDK process session.
 */
export async function setupAutoUpdateSessionForSandbox(
  sandboxId: string,
  agentName: string,
  updateCmd: string,
  quiet = false,
): Promise<void> {
  if (!sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }

  if (!quiet) {
    logStep("Setting up Daytona auto-update session...");
  }

  const sandbox = await ensureSandboxStarted(sandboxId);
  const remotePath = `${await getSandboxHomeDir(sandbox.id)}/.spawn-auto-update.sh`;
  const script = buildAutoUpdateScript(agentName, updateCmd);

  await sandbox.fs.uploadFile(Buffer.from(script), remotePath);
  await sandbox.process.executeCommand(
    formatProcessCommand(`chmod 700 ${shellQuote(remotePath)}`),
    undefined,
    undefined,
    30,
  );

  const sessions = await sandbox.process.listSessions();
  if (sessions.some((session) => session.sessionId === DAYTONA_AUTO_UPDATE_SESSION_ID)) {
    if (!quiet) {
      logInfo("Daytona auto-update session already running");
    }
    return;
  }

  await sandbox.process.createSession(DAYTONA_AUTO_UPDATE_SESSION_ID);
  const command = await sandbox.process.executeSessionCommand(
    DAYTONA_AUTO_UPDATE_SESSION_ID,
    {
      command: formatProcessCommand(remotePath),
      runAsync: true,
    },
    30,
  );
  if (!command.cmdId) {
    throw new Error("Failed to start Daytona auto-update session");
  }

  if (!quiet) {
    logInfo("Daytona auto-update session started");
  }
}

/**
 * Run a non-interactive command inside the active Daytona sandbox.
 */
export async function runServer(cmd: string, timeoutSecs?: number): Promise<void> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }

  const sandbox = await getSandboxById(_state.sandboxId);
  const response = await sandbox.process.executeCommand(formatProcessCommand(cmd), undefined, undefined, timeoutSecs);
  if (response.exitCode !== 0) {
    throw new Error(`runServer failed (exit ${response.exitCode}): ${cmd.slice(0, 80)}`);
  }
}

/**
 * Run a non-interactive command inside a specific Daytona sandbox.
 */
export async function runDaytonaCommand(
  sandboxId: string,
  cmd: string,
  timeoutSecs?: number,
): Promise<{
  exitCode: number;
  output: string;
}> {
  const sandbox = await ensureSandboxStarted(sandboxId);
  const response = await sandbox.process.executeCommand(formatProcessCommand(cmd), undefined, undefined, timeoutSecs);
  return {
    exitCode: response.exitCode ?? 1,
    output: response.result,
  };
}

/**
 * Upload a file into the active Daytona sandbox using the filesystem API.
 */
export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }
  const sandbox = await getSandboxById(_state.sandboxId);
  const resolvedPath = await resolveRemotePath(sandbox.id, remotePath);
  await sandbox.fs.uploadFile(localPath, resolvedPath);
}

/**
 * Download a file from the active Daytona sandbox using the filesystem API.
 */
export async function downloadFile(remotePath: string, localPath: string): Promise<void> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }
  const sandbox = await getSandboxById(_state.sandboxId);
  const resolvedPath = await resolveRemotePath(sandbox.id, remotePath);
  await sandbox.fs.downloadFile(resolvedPath, localPath);
}

function parseSshAccess(sshCommand: string, token: string): DaytonaSshAccess {
  const portMatch = sshCommand.match(/-p\s+(\d+)/);
  const targetMatch = sshCommand.match(/([^\s@]+)@([^\s]+)$/);
  return {
    host: targetMatch?.[2] || DAYTONA_SSH_HOST,
    port: portMatch?.[1],
    token,
  };
}

async function ensureSandboxStarted(sandboxId: string) {
  const sandbox = await getSandboxById(sandboxId);
  if (sandbox.state !== "started") {
    await sandbox.start(60);
  }
  return sandbox;
}

async function getSshAccess(sandboxId: string): Promise<DaytonaSshAccess> {
  const sandbox = await ensureSandboxStarted(sandboxId);
  const sshAccess = await sandbox.createSshAccess(60);
  return parseSshAccess(sshAccess.sshCommand || "", sshAccess.token);
}

/**
 * Build interactive SSH arguments for a Daytona sandbox using a freshly minted SSH access token.
 */
export async function buildInteractiveSshArgs(sandboxId: string, remoteCmd?: string): Promise<string[]> {
  const sshAccess = await getSshAccess(sandboxId);
  const args = [
    "ssh",
    ...SSH_INTERACTIVE_OPTS,
    "-o",
    "PubkeyAuthentication=no",
  ];
  if (sshAccess.port) {
    args.push("-o", `Port=${sshAccess.port}`);
  }
  args.push(`${sshAccess.token}@${sshAccess.host}`);
  if (remoteCmd) {
    args.push("--", `bash -lc ${shellQuote(remoteCmd)}`);
  }
  return args;
}

function getPtySize(): {
  cols: number;
  rows: number;
} {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
  };
}

async function runInteractivePty(sandboxId: string, cmd: string): Promise<number> {
  const sandbox = await ensureSandboxStarted(sandboxId);
  const decoder = new TextDecoder();
  const { cols, rows } = getPtySize();
  const pty = await sandbox.process.createPty({
    id: `spawn-${randomUUID()}`,
    cols,
    rows,
    envs: {
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      LANG: process.env.LANG || "en_US.UTF-8",
    },
    onData: (data) => {
      process.stdout.write(
        decoder.decode(data, {
          stream: true,
        }),
      );
    },
  });

  const onResize = () => {
    const nextSize = getPtySize();
    void pty.resize(nextSize.cols, nextSize.rows);
  };
  const onInput = (data: Buffer | string) => {
    void pty.sendInput(isString(data) ? data : new Uint8Array(data));
  };

  prepareStdinForHandoff();
  process.on("SIGWINCH", onResize);
  process.stdin.on("data", onInput);
  process.stdin.resume();
  process.stdin.setRawMode?.(true);
  const result = await asyncTryCatch(async () => {
    await pty.sendInput(`exec bash -lc ${shellQuote(cmd)}\n`);
    return pty.wait();
  });

  process.stdin.off("data", onInput);
  process.off("SIGWINCH", onResize);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  await asyncTryCatch(() => pty.disconnect());
  process.stdout.write(decoder.decode());

  if (!result.ok) {
    throw result.error;
  }

  return result.data.exitCode ?? 1;
}

export async function runInteractiveDaytonaCommand(sandboxId: string, cmd: string): Promise<number> {
  return runInteractivePty(sandboxId, cmd);
}

/**
 * Open an interactive SSH session into the active Daytona sandbox.
 */
export async function interactiveSession(cmd: string): Promise<number> {
  if (!_state.sandboxId) {
    throw new Error("No Daytona sandbox is active");
  }

  const exitCode = await runInteractivePty(_state.sandboxId, cmd);
  process.stderr.write("\n");
  logWarn(`Session ended. Your sandbox '${_state.sandboxId}' may still be running.`);
  logWarn(`Manage or delete it in the Daytona dashboard: ${DAYTONA_DASHBOARD_URL}`);
  logInfo("Delete it from Spawn with: spawn delete");
  return exitCode;
}

function mapSandboxState(state: string | undefined): "running" | "stopped" | "unknown" {
  switch (state) {
    case "started":
    case "starting":
    case "running":
      return "running";
    case "stopped":
    case "stopping":
    case "archived":
      return "stopped";
    default:
      return "unknown";
  }
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof DaytonaNotFoundError) {
    return true;
  }
  return error instanceof Error && /404|not found/i.test(error.message);
}

/**
 * Delete a Daytona sandbox by ID.
 */
export async function destroyServer(sandboxId?: string): Promise<void> {
  const targetId = sandboxId || _state.sandboxId;
  if (!targetId) {
    throw new Error("No Daytona sandbox ID");
  }

  const client = await getRequiredClient();
  const sandbox = await client.get(targetId);
  await client.delete(sandbox, 60);
}

/**
 * List Daytona sandboxes in the generic cloud-instance shape used by Spawn.
 */
export async function listServers(): Promise<CloudInstance[]> {
  const client = await getRequiredClient();
  const sandboxes = await client.list(undefined, 1, 100);
  return sandboxes.items.map((sandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    ip: DAYTONA_SSH_HOST,
    status: mapSandboxState(sandbox.state),
  }));
}

/**
 * Resolve a live-state value for Spawn's status command.
 */
export async function getDaytonaLiveState(sandboxId: string): Promise<"running" | "stopped" | "gone" | "unknown"> {
  const stateResult = await asyncTryCatch(async () => {
    const client = await getDaytonaClient(false);
    if (!client) {
      return "unknown" as const;
    }
    const sandbox = await client.get(sandboxId);
    return mapSandboxState(sandbox.state);
  });
  if (stateResult.ok) {
    return stateResult.data;
  }
  if (isNotFoundError(stateResult.error)) {
    return "gone";
  }
  return "unknown";
}

/**
 * Probe whether an agent binary is installed inside a Daytona sandbox without opening SSH.
 */
export async function probeDaytonaAgentBinary(sandboxId: string, binary: string): Promise<boolean> {
  const probeResult = await asyncTryCatch(async () => {
    const client = await getDaytonaClient(false);
    if (!client) {
      return false;
    }
    const sandbox = await client.get(sandboxId);
    if (mapSandboxState(sandbox.state) !== "running") {
      return false;
    }

    const versionCmd =
      "source ~/.spawnrc 2>/dev/null; " +
      `export PATH="$HOME/.local/bin:$HOME/.claude/local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.n/bin:$PATH"; ` +
      `${binary} --version`;
    const response = await sandbox.process.executeCommand(formatProcessCommand(versionCmd), undefined, undefined, 10);
    return response.exitCode === 0;
  });
  return probeResult.ok ? probeResult.data : false;
}

/**
 * Create a signed preview URL for a Daytona sandbox and return the browser-openable URL.
 */
export async function getSignedPreviewBrowserUrl(
  sandboxId: string | undefined,
  remotePort: number,
  urlSuffix = "",
  expiresInSeconds = DAYTONA_SIGNED_PREVIEW_DEFAULT_SECONDS,
): Promise<string> {
  validatePreviewSuffix(urlSuffix);
  const targetId = sandboxId || _state.sandboxId;
  if (!targetId) {
    throw new Error("No Daytona sandbox is active");
  }
  const sandbox = await ensureSandboxStarted(targetId);
  const preview = await sandbox.getSignedPreviewUrl(remotePort, expiresInSeconds);
  await prepareOpenClawPreviewAccess(targetId, remotePort, preview.url, urlSuffix);
  return preview.url + urlSuffix;
}

function isOpenClawPreview(remotePort: number, urlSuffix: string): boolean {
  return remotePort === OPENCLAW_DASHBOARD_PORT && urlSuffix.includes("#token=");
}

async function prepareOpenClawPreviewAccess(
  sandboxId: string,
  remotePort: number,
  previewUrl: string,
  urlSuffix: string,
): Promise<void> {
  if (!isOpenClawPreview(remotePort, urlSuffix)) {
    return;
  }

  await allowOpenClawPreviewOrigin(sandboxId, previewUrl);
  await armOpenClawDashboardPairingWatcher(sandboxId);
}

/** Allow the exact Daytona preview origin for OpenClaw's control UI before opening the dashboard.
 *  OpenClaw rejects browser origins it does not recognize, so Daytona's signed preview host
 *  must be appended on demand rather than during initial setup when the preview host is unknown. */
async function allowOpenClawPreviewOrigin(sandboxId: string, previewUrl: string): Promise<void> {
  const previewOrigin = new URL(previewUrl).origin;
  const escapedOrigin = JSON.stringify(previewOrigin);
  const patchConfigCmd = [
    "node -e",
    shellQuote(
      `
const fs = require("node:fs");
const path = process.env.HOME + "/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const gateway = config.gateway ?? (config.gateway = {});
const controlUi = gateway.controlUi ?? (gateway.controlUi = {});
const allowedOrigins = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
if (!allowedOrigins.includes(${escapedOrigin})) {
  allowedOrigins.push(${escapedOrigin});
}
controlUi.allowedOrigins = allowedOrigins;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n", { mode: 0o600 });
      `.trim(),
    ),
  ].join(" ");

  await runDaytonaCommand(sandboxId, patchConfigCmd, 30);
}

/** Auto-approve the first remote browser pairing request for the OpenClaw dashboard.
 *  Daytona preview URLs are remote origins, so OpenClaw correctly requires one-time
 *  device approval for a new browser profile. Spawn arms a short-lived watcher right
 *  before opening the dashboard so the user does not have to approve that request manually. */
async function armOpenClawDashboardPairingWatcher(sandboxId: string): Promise<void> {
  const sandbox = await ensureSandboxStarted(sandboxId);
  const remotePath = `${await getSandboxHomeDir(sandbox.id)}/.spawn-openclaw-dashboard-pair.sh`;
  const watcherScript = buildOpenClawDashboardPairingWatcherScript();

  await sandbox.fs.uploadFile(Buffer.from(watcherScript), remotePath);
  await sandbox.process.executeCommand(
    formatProcessCommand(`chmod 700 ${shellQuote(remotePath)}`),
    undefined,
    undefined,
    30,
  );

  const launchWatcherCmd = `nohup ${shellQuote(remotePath)} > ${shellQuote(OPENCLAW_DASHBOARD_PAIR_LOG_PATH)} 2>&1 < /dev/null &`;
  await sandbox.process.executeCommand(formatProcessCommand(launchWatcherCmd), undefined, undefined, 30);
}

function buildOpenClawDashboardPairingWatcherScript(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'export PATH="$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
    "",
    `for _attempt in $(seq 1 ${OPENCLAW_DASHBOARD_PAIR_POLL_ATTEMPTS}); do`,
    '  _devices_json="$(openclaw devices list --json 2>/dev/null)" || { sleep ' +
      `${OPENCLAW_DASHBOARD_PAIR_POLL_INTERVAL_SECONDS}; continue; }`,
    '  _request_id="$(printf "%s" "$_devices_json" | node -e ' +
      `"const fs = require('node:fs'); ` +
      "const data = JSON.parse(fs.readFileSync(0, 'utf8')); " +
      "const request = data.pending?.find((entry) => entry.clientId === 'openclaw-control-ui' && entry.clientMode === 'webchat' && entry.role === 'operator' && Array.isArray(entry.scopes) && entry.scopes.includes('operator.pairing')); " +
      'if (request?.requestId) process.stdout.write(request.requestId);"' +
      ' 2>/dev/null)"',
    '  if [ -n "$_request_id" ]; then',
    '    openclaw devices approve "$_request_id"',
    "    exit 0",
    "  fi",
    `  sleep ${OPENCLAW_DASHBOARD_PAIR_POLL_INTERVAL_SECONDS}`,
    "done",
    "",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Run the generated Spawn fix script inside a Daytona sandbox using filesystem and process APIs.
 */
export async function runDaytonaFixScript(
  sandboxId: string,
  script: string,
): Promise<{
  exitCode: number;
  output: string;
}> {
  const sandbox = await ensureSandboxStarted(sandboxId);
  const remotePath = `/tmp/spawn-fix-${Date.now()}.sh`;

  await sandbox.fs.uploadFile(Buffer.from(script), remotePath);
  await sandbox.process.executeCommand(
    formatProcessCommand(`chmod 700 ${shellQuote(remotePath)}`),
    undefined,
    undefined,
    30,
  );

  const response = await sandbox.process.executeCommand(formatProcessCommand(remotePath), undefined, undefined, 300);

  await sandbox.process.executeCommand(
    formatProcessCommand(`rm -f ${shellQuote(remotePath)}`),
    undefined,
    undefined,
    30,
  );

  return {
    exitCode: response.exitCode ?? 1,
    output: response.result,
  };
}

function validatePreviewSuffix(suffix: string): void {
  if (!suffix) {
    return;
  }
  if (suffix.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(suffix)) {
    throw new Error(`Invalid Daytona preview suffix: ${suffix}`);
  }
  if (!/^(?:[/?#][a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]*)$/.test(suffix)) {
    throw new Error(`Invalid Daytona preview suffix: ${suffix}`);
  }
}

/** Validate the strict Daytona connection shape. */
export function validateDaytonaConnection(connection: VMConnection): void {
  if (connection.ip === "daytona-sandbox" || connection.ip === "token-auth") {
    throw new Error("Invalid Daytona connection shape");
  }

  validateConnectionIP(connection.ip);
  validateUsername(connection.user);

  if (!connection.server_id) {
    throw new Error("Daytona connection is missing server_id");
  }
  validateServerIdentifier(connection.server_id);

  if (connection.server_name) {
    validateServerIdentifier(connection.server_name);
  }

  const metadata = connection.metadata;
  if (!metadata) {
    return;
  }

  for (const key of Object.keys(metadata)) {
    if (!DAYTONA_ALLOWED_METADATA_KEYS.has(key)) {
      throw new Error(`Invalid Daytona metadata key: ${key}`);
    }
  }

  if (metadata.tunnel_remote_port !== undefined) {
    validateTunnelPort(metadata.tunnel_remote_port);
  }
  if (metadata.tunnel_browser_url_template !== undefined) {
    validateTunnelUrl(metadata.tunnel_browser_url_template);
  }
  if (
    metadata.auto_update_enabled !== undefined &&
    metadata.auto_update_enabled !== "0" &&
    metadata.auto_update_enabled !== "1"
  ) {
    throw new Error(`Invalid Daytona auto-update metadata value: ${metadata.auto_update_enabled}`);
  }
}
