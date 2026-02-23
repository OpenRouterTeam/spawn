// daytona/daytona.ts — Core Daytona provider: API, SSH, provisioning, execution

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  jsonEscape,
  validateServerName,
  toKebabCase,
  defaultSpawnName,
  sanitizeTermValue,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import { parseJsonWith, parseJsonRaw } from "../shared/parse";
import * as v from "valibot";

const DAYTONA_API_BASE = "https://app.daytona.io/api";
const DAYTONA_DASHBOARD_URL = "https://app.daytona.io/";

// ─── State ───────────────────────────────────────────────────────────────────

let daytonaApiKey = "";
let sandboxId = "";
let sshToken = "";
let sshHost = "";
let sshPort = "";

export function getState() {
  return {
    daytonaApiKey,
    sandboxId,
    sshToken,
    sshHost,
    sshPort,
  };
}

// ─── API Client ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const LooseObject = v.record(v.string(), v.unknown());

/** Parse a JSON string into a Record<string, unknown> via valibot, or null. */
function parseJson(text: string): Record<string, unknown> | null {
  return parseJsonWith(text, LooseObject);
}

/** Narrow an already-parsed unknown value to a Record<string, unknown>, or null. */
function toRecord(val: unknown): Record<string, unknown> | null {
  const result = v.safeParse(LooseObject, val);
  return result.success ? result.output : null;
}

/** Filter an array to only Record<string, unknown> entries. */
function toObjectArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) { return []; }
  return val.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

async function daytonaApi(method: string, endpoint: string, body?: string, maxRetries = 3): Promise<string> {
  const url = `${DAYTONA_API_BASE}${endpoint}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${daytonaApiKey}`,
      };
      const opts: RequestInit = {
        method,
        headers,
      };
      if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        opts.body = body;
      }
      const resp = await fetch(url, opts);
      const text = await resp.text();

      if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
        logWarn(`API ${resp.status} (attempt ${attempt}/${maxRetries}), retrying in ${interval}s...`);
        await sleep(interval * 1000);
        interval = Math.min(interval * 2, 30);
        continue;
      }
      return text;
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err;
      }
      logWarn(`API request failed (attempt ${attempt}/${maxRetries}), retrying...`);
      await sleep(interval * 1000);
      interval = Math.min(interval * 2, 30);
    }
  }
  throw new Error("daytonaApi: unreachable");
}

function hasApiError(text: string): boolean {
  return /"statusCode"\s*:\s*4|"unauthorized"|"forbidden"/i.test(text);
}

function extractApiError(text: string, fallback = "Unknown error"): string {
  const data = parseJson(text);
  if (!data) {
    return fallback;
  }
  const msg = data.message || data.error || data.detail;
  return typeof msg === "string" ? msg : fallback;
}

// ─── Token Management ────────────────────────────────────────────────────────

const DAYTONA_CONFIG_PATH = `${process.env.HOME}/.config/spawn/daytona.json`;

async function saveTokenToConfig(token: string): Promise<void> {
  const dir = DAYTONA_CONFIG_PATH.replace(/\/[^/]+$/, "");
  await Bun.spawn([
    "mkdir",
    "-p",
    dir,
  ]).exited;
  const escaped = jsonEscape(token);
  await Bun.write(DAYTONA_CONFIG_PATH, `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`, {
    mode: 0o600,
  });
}

function loadTokenFromConfig(): string | null {
  try {
    const data = JSON.parse(readFileSync(DAYTONA_CONFIG_PATH, "utf-8"));
    const token = data.api_key || data.token || "";
    if (!token) {
      return null;
    }
    if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(token)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

async function testDaytonaToken(): Promise<boolean> {
  if (!daytonaApiKey) {
    return false;
  }
  try {
    const resp = await daytonaApi("GET", "/sandbox?page=1&limit=1", undefined, 1);
    if (hasApiError(resp)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaytonaToken(): Promise<void> {
  // 1. Env var
  if (process.env.DAYTONA_API_KEY) {
    daytonaApiKey = process.env.DAYTONA_API_KEY.trim();
    if (await testDaytonaToken()) {
      logInfo("Using Daytona API key from environment");
      await saveTokenToConfig(daytonaApiKey);
      return;
    }
    logWarn("DAYTONA_API_KEY from environment is invalid");
    daytonaApiKey = "";
  }

  // 2. Saved config
  const saved = loadTokenFromConfig();
  if (saved) {
    daytonaApiKey = saved;
    if (await testDaytonaToken()) {
      logInfo("Using saved Daytona API key");
      return;
    }
    logWarn("Saved Daytona token is invalid or expired");
    daytonaApiKey = "";
  }

  // 3. Manual token entry
  logStep("Manual token entry");
  logWarn("Get your API key from: https://app.daytona.io/dashboard/keys");
  const token = await prompt("Enter your Daytona API key: ");
  if (!token) {
    throw new Error("No token provided");
  }
  daytonaApiKey = token.trim();
  if (!(await testDaytonaToken())) {
    logError("Token is invalid");
    daytonaApiKey = "";
    throw new Error("Invalid Daytona token");
  }
  await saveTokenToConfig(daytonaApiKey);
  logInfo("Using manually entered Daytona API key");
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

function saveVmConnection(
  ip: string,
  user: string,
  serverId: string,
  serverName: string,
  cloud: string,
  launchCmd?: string,
): void {
  const dir = `${process.env.HOME}/.spawn`;
  mkdirSync(dir, {
    recursive: true,
  });
  const json: Record<string, string> = {
    ip,
    user,
  };
  if (serverId) {
    json.server_id = serverId;
  }
  if (serverName) {
    json.server_name = serverName;
  }
  if (cloud) {
    json.cloud = cloud;
  }
  if (launchCmd) {
    json.launch_cmd = launchCmd;
  }
  writeFileSync(`${dir}/last-connection.json`, JSON.stringify(json) + "\n");
}

export function saveLaunchCmd(launchCmd: string): void {
  const connFile = `${process.env.HOME}/.spawn/last-connection.json`;
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    writeFileSync(connFile, JSON.stringify(data) + "\n");
  } catch {
    // non-fatal
  }
}

// ─── SSH Helpers ─────────────────────────────────────────────────────────────

/** Build SSH args common to all SSH operations. */
function sshBaseArgs(): string[] {
  const args = [
    "ssh",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "PubkeyAuthentication=no",
  ];
  if (sshPort) {
    args.push("-o", `Port=${sshPort}`);
  }
  return args;
}

// ─── Provisioning ────────────────────────────────────────────────────────────

async function setupSshAccess(): Promise<void> {
  logStep("Setting up SSH access...");

  const sshResp = await daytonaApi("POST", `/sandbox/${sandboxId}/ssh-access?expiresInMinutes=480`);
  const data = parseJson(sshResp);
  if (!data) {
    logError("Failed to parse SSH access response");
    throw new Error("SSH access parse failure");
  }

  sshToken = typeof data.token === "string" ? data.token : "";
  const sshCommand = typeof data.sshCommand === "string" ? data.sshCommand : "";

  if (!sshToken) {
    logError(`Failed to get SSH access: ${extractApiError(sshResp)}`);
    throw new Error("SSH access failed");
  }

  // Parse host from sshCommand (e.g., "ssh -p 2222 TOKEN@HOST" or "ssh TOKEN@HOST")
  const hostMatch = sshCommand.match(/[^@ ]+$/);
  sshHost = hostMatch ? hostMatch[0] : "ssh.app.daytona.io";

  // Parse port if present
  const portMatch = sshCommand.match(/-p\s+(\d+)/);
  sshPort = portMatch ? portMatch[1] : "";

  logInfo("SSH access ready");
}

export async function createServer(name: string): Promise<void> {
  const cpu = Number.parseInt(process.env.DAYTONA_CPU || "2", 10);
  const memory = Number.parseInt(process.env.DAYTONA_MEMORY || "4", 10);
  const disk = Number.parseInt(process.env.DAYTONA_DISK || "30", 10);

  logStep(`Creating Daytona sandbox '${name}' (${cpu} vCPU, ${memory} GiB RAM, ${disk} GiB disk)...`);

  const image = process.env.DAYTONA_IMAGE || "daytonaio/sandbox:latest";
  if (/[^a-zA-Z0-9./:_-]/.test(image)) {
    logError(`Invalid image name: ${image}`);
    throw new Error("Invalid image");
  }
  const dockerfile = `FROM ${image}`;

  const body = JSON.stringify({
    name,
    buildInfo: {
      dockerfileContent: dockerfile,
    },
    cpu,
    memory,
    disk,
    autoStopInterval: 0,
    autoArchiveInterval: 0,
  });

  const response = await daytonaApi("POST", "/sandbox", body);
  const data = parseJson(response);

  sandboxId = typeof data?.id === "string" ? data.id : "";
  if (!sandboxId) {
    logError(`Failed to create sandbox: ${extractApiError(response)}`);
    throw new Error("Sandbox creation failed");
  }

  logInfo(`Sandbox created: ${sandboxId}`);

  // Wait for sandbox to reach started state
  logStep("Waiting for sandbox to start...");
  const maxWait = 120;
  let waited = 0;
  while (waited < maxWait) {
    const statusResp = await daytonaApi("GET", `/sandbox/${sandboxId}`);
    const statusData = parseJson(statusResp);
    const state = typeof statusData?.state === "string" ? statusData.state : "";

    if (state === "started" || state === "running") {
      break;
    }
    if (state === "error" || state === "failed") {
      const reason = typeof statusData?.errorReason === "string" ? statusData.errorReason : "unknown";
      logError(`Sandbox entered error state: ${reason}`);
      throw new Error("Sandbox error state");
    }

    await sleep(3000);
    waited += 3;
  }

  if (waited >= maxWait) {
    logError(`Sandbox did not start within ${maxWait}s`);
    logWarn(`Check sandbox status at: ${DAYTONA_DASHBOARD_URL}`);
    throw new Error("Sandbox start timeout");
  }

  // Set up SSH access
  await setupSshAccess();

  saveVmConnection(sshHost, sshToken, sandboxId, name, "daytona");
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Run a command on the remote sandbox via SSH.
 * Adds a brief sleep after each call to let Daytona's gateway release the connection slot.
 */
export async function runServer(cmd: string): Promise<void> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const args = [
    ...sshBaseArgs(),
    "-o",
    "BatchMode=yes",
    `${sshToken}@${sshHost}`,
    "--",
    fullCmd,
  ];

  const proc = Bun.spawn(args, {
    stdio: [
      "pipe",
      "inherit",
      "inherit",
    ],
  });
  // Close stdin but keep process alive (Daytona gateway doesn't propagate stdin EOF)
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  const exitCode = await proc.exited;

  // Brief sleep to let gateway release connection slot
  await sleep(1000);

  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

/** Run a command and capture stdout. */
export async function runServerCapture(cmd: string): Promise<string> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const args = [
    ...sshBaseArgs(),
    "-o",
    "BatchMode=yes",
    `${sshToken}@${sshHost}`,
    "--",
    fullCmd,
  ];

  const proc = Bun.spawn(args, {
    stdio: [
      "pipe",
      "pipe",
      "pipe",
    ],
  });
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  await sleep(1000);

  if (exitCode !== 0) {
    throw new Error(`run_server_capture failed (exit ${exitCode})`);
  }
  return stdout.trim();
}

/**
 * Upload a file to the remote sandbox via base64-encoded SSH command channel.
 * Daytona's SSH gateway doesn't support SCP/SFTP.
 */
export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath) || remotePath.includes("..")) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }

  const content: Buffer = readFileSync(localPath);
  const b64 = content.toString("base64");

  // Validate base64 only contains safe characters
  if (/[^A-Za-z0-9+/=]/.test(b64)) {
    logError("upload_file: base64 output contains unexpected characters");
    throw new Error("Invalid base64");
  }

  const args = [
    ...sshBaseArgs(),
    "-o",
    "BatchMode=yes",
    `${sshToken}@${sshHost}`,
    "--",
    `printf '%s' '${b64}' | base64 -d > '${remotePath}'`,
  ];

  const proc = Bun.spawn(args, {
    stdio: [
      "pipe",
      "ignore",
      "ignore",
    ],
  });
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  const exitCode = await proc.exited;

  await sleep(1000);

  if (exitCode !== 0) {
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string): Promise<number> {
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM=${term} PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${JSON.stringify(cmd)}`;

  // Interactive mode — drop BatchMode so the PTY works
  const args = [
    ...sshBaseArgs(),
    "-t", // Force PTY allocation
    `${sshToken}@${sshHost}`,
    "--",
    fullCmd,
  ];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your sandbox '${sandboxId}' may still be running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${DAYTONA_DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");

  return exitCode;
}

// ─── Cloud Init ──────────────────────────────────────────────────────────────

export async function waitForSsh(maxAttempts = 20): Promise<void> {
  logStep("Waiting for SSH connectivity...");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await runServerCapture("echo ok");
      if (output.includes("ok")) {
        logInfo("SSH is ready");
        return;
      }
    } catch {
      // ignore
    }
    logStep(`SSH not ready yet (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
  logError(`SSH connectivity failed after ${maxAttempts} attempts`);
  throw new Error("SSH wait timeout");
}

export async function waitForCloudInit(tier: CloudInitTier = "full"): Promise<void> {
  await waitForSsh();

  const packages = getPackagesForTier(tier);
  logStep("Installing base tools in sandbox...");
  const parts = [
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -y",
    `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
  ];
  if (needsNode(tier)) {
    parts.push(NODE_INSTALL_CMD);
  }
  if (needsBun(tier)) {
    parts.push("curl -fsSL https://bun.sh/install | bash");
  }
  parts.push(
    `echo 'export PATH="\${HOME}/.local/bin:\${HOME}/.bun/bin:\${PATH}"' >> ~/.bashrc`,
    `echo 'export PATH="\${HOME}/.local/bin:\${HOME}/.bun/bin:\${PATH}"' >> ~/.zshrc`,
  );

  try {
    await runServer(parts.join(" && "));
  } catch {
    logWarn("Base tools install had errors, continuing...");
  }
  logInfo("Base tools installed");
}

// ─── Server Name ─────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  if (process.env.DAYTONA_SANDBOX_NAME) {
    const name = process.env.DAYTONA_SANDBOX_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid DAYTONA_SANDBOX_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using sandbox name from environment: ${name}`);
    return name;
  }

  const kebab = process.env.SPAWN_NAME_KEBAB || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  return kebab || defaultSpawnName();
}

export async function promptSpawnName(): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) {
    return;
  }

  let kebab: string;
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    kebab = (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "") || defaultSpawnName();
  } else {
    const derived = process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "";
    const fallback = derived || defaultSpawnName();
    process.stderr.write("\n");
    const answer = await prompt(`Daytona workspace name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(id?: string): Promise<void> {
  const targetId = id || sandboxId;
  if (!targetId) {
    logWarn("No sandbox ID to destroy");
    return;
  }

  logStep(`Destroying sandbox ${targetId}...`);
  const response = await daytonaApi("DELETE", `/sandbox/${targetId}`);

  if (response && hasApiError(response)) {
    logError(`Failed to destroy sandbox ${targetId}`);
    logError(`API Error: ${extractApiError(response)}`);
    logWarn("The sandbox may still be running and incurring charges.");
    logWarn(`Delete it manually at: ${DAYTONA_DASHBOARD_URL}`);
    throw new Error("Sandbox deletion failed");
  }

  logInfo("Sandbox destroyed");
}

export async function listServers(): Promise<void> {
  const response = await daytonaApi("GET", "/sandbox");
  const raw = parseJsonRaw(response);
  const parsed = toRecord(raw);
  const rawItems = Array.isArray(raw) ? raw : (parsed?.items ?? parsed?.sandboxes ?? []);
  const items = toObjectArray(rawItems);

  if (items.length === 0) {
    console.log("No sandboxes found");
    return;
  }

  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("NAME", 25) + pad("ID", 40) + pad("STATE", 12));
  console.log("-".repeat(77));
  for (const s of items) {
    const name = typeof s.name === "string" ? s.name : "N/A";
    const id = typeof s.id === "string" ? s.id : "N/A";
    const state = typeof s.state === "string" ? s.state : "N/A";
    console.log(
      pad(name.slice(0, 24), 25) +
        pad(id.slice(0, 39), 40) +
        pad(state.slice(0, 11), 12),
    );
  }
}
