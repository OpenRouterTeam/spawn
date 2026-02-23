// hetzner/hetzner.ts — Core Hetzner Cloud provider: API, auth, SSH, provisioning

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  jsonEscape,
  validateServerName,
  validateRegionName,
  toKebabCase,
  defaultSpawnName,
  sanitizeTermValue,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import { SSH_BASE_OPTS, sleep, waitForSsh as sharedWaitForSsh } from "../shared/ssh";
import * as v from "valibot";
import { parseJsonWith } from "../shared/parse";
import { getSpawnDir, getConnectionPath } from "../history.js";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const HETZNER_DASHBOARD_URL = "https://console.hetzner.cloud/";

// ─── State ───────────────────────────────────────────────────────────────────
let hcloudToken = "";
let hetznerServerId = "";
let hetznerServerIp = "";

export function getState() {
  return {
    hcloudToken,
    hetznerServerId,
    hetznerServerIp,
  };
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function hetznerApi(method: string, endpoint: string, body?: string, maxRetries = 3): Promise<string> {
  const url = `${HETZNER_API_BASE}${endpoint}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hcloudToken}`,
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
  throw new Error("hetznerApi: unreachable");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LooseObject = v.record(v.string(), v.unknown());

function parseJson(text: string): Record<string, unknown> | null {
  return parseJsonWith(text, LooseObject);
}

/** Narrow an unknown value to a Record if it is a non-array object */
function rec(val: unknown): Record<string, unknown> | undefined {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return Object.fromEntries(Object.entries(val));
  }
  return undefined;
}

/** Extract an array of record objects from an unknown value */
function toObjectArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) {
    return [];
  }
  const result: Record<string, unknown>[] = [];
  for (const item of val) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      result.push(Object.fromEntries(Object.entries(item)));
    }
  }
  return result;
}

// ─── Token Persistence ───────────────────────────────────────────────────────

const HETZNER_CONFIG_PATH = `${process.env.HOME}/.config/spawn/hetzner.json`;

async function saveTokenToConfig(token: string): Promise<void> {
  const dir = HETZNER_CONFIG_PATH.replace(/\/[^/]+$/, "");
  await Bun.spawn([
    "mkdir",
    "-p",
    dir,
  ]).exited;
  const escaped = jsonEscape(token);
  await Bun.write(HETZNER_CONFIG_PATH, `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`, {
    mode: 0o600,
  });
}

function loadTokenFromConfig(): string | null {
  try {
    const data = JSON.parse(readFileSync(HETZNER_CONFIG_PATH, "utf-8"));
    const token = data.api_key || data.token || "";
    if (!token) {
      return null;
    }
    // Security: validate token chars
    if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(token)) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

// ─── Token Validation ────────────────────────────────────────────────────────

async function testHcloudToken(): Promise<boolean> {
  if (!hcloudToken) {
    return false;
  }
  try {
    const resp = await hetznerApi("GET", "/servers?per_page=1", undefined, 1);
    const data = parseJson(resp);
    // Hetzner returns { "error": { ... } } on auth failure.
    // Success responses may contain "error": null inside action objects,
    // so check for a real error object with a message.
    if (rec(data?.error)?.message) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Authentication ──────────────────────────────────────────────────────────

export async function ensureHcloudToken(): Promise<void> {
  // 1. Env var
  if (process.env.HCLOUD_TOKEN) {
    hcloudToken = process.env.HCLOUD_TOKEN.trim();
    if (await testHcloudToken()) {
      logInfo("Using Hetzner Cloud token from environment");
      await saveTokenToConfig(hcloudToken);
      return;
    }
    logWarn("HCLOUD_TOKEN from environment is invalid");
    hcloudToken = "";
  }

  // 2. Saved config
  const saved = loadTokenFromConfig();
  if (saved) {
    hcloudToken = saved;
    if (await testHcloudToken()) {
      logInfo("Using saved Hetzner Cloud token");
      return;
    }
    logWarn("Saved Hetzner token is invalid or expired");
    hcloudToken = "";
  }

  // 3. Manual entry
  logStep("Hetzner Cloud API Token Required");
  logWarn("Get a token from: https://console.hetzner.cloud/projects -> API Tokens");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = await prompt("Enter your Hetzner Cloud API token: ");
    if (!token) {
      logError("Token cannot be empty");
      continue;
    }
    hcloudToken = token.trim();
    if (await testHcloudToken()) {
      await saveTokenToConfig(hcloudToken);
      logInfo("Hetzner Cloud token validated and saved");
      return;
    }
    logError("Token is invalid");
    hcloudToken = "";
  }

  logError("No valid token after 3 attempts");
  throw new Error("Hetzner authentication failed");
}

// ─── SSH Key Management ──────────────────────────────────────────────────────

function generateSshKeyIfMissing(): {
  pubPath: string;
  privPath: string;
} {
  const sshDir = `${process.env.HOME}/.ssh`;
  const privPath = `${sshDir}/id_ed25519`;
  const pubPath = `${privPath}.pub`;

  if (existsSync(pubPath) && existsSync(privPath)) {
    return {
      pubPath,
      privPath,
    };
  }

  mkdirSync(sshDir, {
    recursive: true,
    mode: 0o700,
  });
  logStep("Generating SSH key...");
  const result = Bun.spawnSync(
    [
      "ssh-keygen",
      "-t",
      "ed25519",
      "-f",
      privPath,
      "-N",
      "",
      "-C",
      "spawn",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  if (result.exitCode !== 0) {
    throw new Error("SSH key generation failed");
  }
  logInfo("SSH key generated");
  return {
    pubPath,
    privPath,
  };
}

function getSshFingerprint(pubPath: string): string {
  const result = Bun.spawnSync(
    [
      "ssh-keygen",
      "-lf",
      pubPath,
      "-E",
      "md5",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );
  const output = new TextDecoder().decode(result.stdout).trim();
  // Format: "2048 MD5:xx:xx:xx... user@host (ED25519)"
  const match = output.match(/MD5:([a-f0-9:]+)/i);
  return match ? match[1] : "";
}

export async function ensureSshKey(): Promise<void> {
  const { pubPath } = generateSshKeyIfMissing();
  const fingerprint = getSshFingerprint(pubPath);
  const pubKey = readFileSync(pubPath, "utf-8").trim();

  // Check if key is already registered
  const resp = await hetznerApi("GET", "/ssh_keys");
  const data = parseJson(resp);
  const sshKeys = toObjectArray(data?.ssh_keys);

  for (const key of sshKeys) {
    if (fingerprint && key.fingerprint === fingerprint) {
      logInfo("SSH key already registered with Hetzner");
      return;
    }
  }

  // Register key
  logStep("Registering SSH key with Hetzner...");
  const keyName = `spawn-${Date.now()}`;
  const body = JSON.stringify({
    name: keyName,
    public_key: pubKey,
  });
  const regResp = await hetznerApi("POST", "/ssh_keys", body);
  const regData = parseJson(regResp);
  const regError = rec(regData?.error);
  const regErrMsg = typeof regError?.message === "string" ? regError.message : "";
  if (regErrMsg) {
    // Key may already exist under a different name — non-fatal
    if (/already/.test(regErrMsg)) {
      logInfo("SSH key already registered (different name)");
      return;
    }
    logError(`Failed to register SSH key: ${regErrMsg}`);
    throw new Error("SSH key registration failed");
  }
  logInfo("SSH key registered with Hetzner");
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

export function saveVmConnection(
  ip: string,
  user: string,
  serverId: string,
  serverName: string,
  cloud: string,
  launchCmd?: string,
): void {
  const dir = getSpawnDir();
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
  const connFile = getConnectionPath();
  try {
    const data = JSON.parse(readFileSync(connFile, "utf-8"));
    data.launch_cmd = launchCmd;
    writeFileSync(connFile, JSON.stringify(data) + "\n");
  } catch {
    // non-fatal
  }
}

// ─── Cloud Init Userdata ────────────────────────────────────────────────────

function getCloudInitUserdata(tier: CloudInitTier = "full"): string {
  const packages = getPackagesForTier(tier);
  const lines = [
    "#!/bin/bash",
    "set -e",
    "export HOME=/root",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -y",
    `apt-get install -y --no-install-recommends ${packages.join(" ")}`,
  ];
  if (needsNode(tier)) {
    lines.push(`${NODE_INSTALL_CMD} || true`);
  }
  if (needsBun(tier)) {
    lines.push(
      "curl -fsSL https://bun.sh/install | bash || true",
      "ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true",
    );
  }
  lines.push(
    "echo 'export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$PATH\"' >> /root/.bashrc",
    "echo 'export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$PATH\"' >> /root/.zshrc",
    "touch /home/ubuntu/.cloud-init-complete 2>/dev/null; touch /root/.cloud-init-complete",
  );
  return lines.join("\n");
}

// ─── Provisioning ────────────────────────────────────────────────────────────

export async function createServer(
  name: string,
  serverType?: string,
  location?: string,
  tier?: CloudInitTier,
): Promise<void> {
  const sType = serverType || process.env.HETZNER_SERVER_TYPE || "cx23";
  const loc = location || process.env.HETZNER_LOCATION || "nbg1";
  const image = "ubuntu-24.04";

  if (!validateRegionName(loc)) {
    logError("Invalid HETZNER_LOCATION");
    throw new Error("Invalid location");
  }

  logStep(`Creating Hetzner server '${name}' (type: ${sType}, location: ${loc})...`);

  // Get all SSH key IDs
  const keysResp = await hetznerApi("GET", "/ssh_keys");
  const keysData = parseJson(keysResp);
  const sshKeyIds: number[] = toObjectArray(keysData?.ssh_keys)
    .map((k) => (typeof k.id === "number" ? k.id : 0))
    .filter(Boolean);

  const userdata = getCloudInitUserdata(tier);
  const body = JSON.stringify({
    name,
    server_type: sType,
    location: loc,
    image,
    ssh_keys: sshKeyIds,
    user_data: userdata,
    start_after_create: true,
  });

  const resp = await hetznerApi("POST", "/servers", body);
  const data = parseJson(resp);

  // Hetzner success responses contain "error": null in action objects,
  // so check for presence of .server object, not absence of "error" string.
  const server = rec(data?.server);
  if (!server) {
    const errMsg = rec(data?.error)?.message || "Unknown error";
    logError(`Failed to create Hetzner server: ${errMsg}`);
    logWarn("Common issues:");
    logWarn("  - Insufficient account balance or payment method required");
    logWarn("  - Server type/location unavailable");
    logWarn("  - Server limit reached for your account");
    logWarn(`Check your dashboard: ${HETZNER_DASHBOARD_URL}`);
    throw new Error(`Server creation failed: ${errMsg}`);
  }

  hetznerServerId = String(server.id);
  const publicNet = rec(server.public_net);
  const ipv4 = rec(publicNet?.ipv4);
  hetznerServerIp = typeof ipv4?.ip === "string" ? ipv4.ip : "";

  if (!hetznerServerId || hetznerServerId === "null") {
    logError("Failed to extract server ID from API response");
    throw new Error("No server ID");
  }
  if (!hetznerServerIp || hetznerServerIp === "null") {
    logError("Failed to extract server IP from API response");
    throw new Error("No server IP");
  }

  logInfo(`Server created: ID=${hetznerServerId}, IP=${hetznerServerIp}`);
  saveVmConnection(hetznerServerIp, "root", hetznerServerId, name, "hetzner");
}

// ─── SSH Execution ───────────────────────────────────────────────────────────

const SSH_OPTS = SSH_BASE_OPTS;

export async function waitForCloudInit(ip?: string, _maxAttempts = 60): Promise<void> {
  const serverIp = ip || hetznerServerIp;
  await sharedWaitForSsh({
    host: serverIp,
    user: "root",
    maxAttempts: 36,
  });

  logStep("Waiting for cloud-init to complete...");
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "ssh",
          ...SSH_OPTS,
          `root@${serverIp}`,
          "test -f /root/.cloud-init-complete && echo done",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode === 0 && stdout.includes("done")) {
        logInfo("Cloud-init complete");
        return;
      }
    } catch {
      // ignore
    }
    if (attempt >= 60) {
      logWarn("Cloud-init marker not found, continuing anyway...");
      return;
    }
    logStep(`Cloud-init in progress (${attempt}/60)`);
    await sleep(5000);
  }
}

export async function runServer(cmd: string, timeoutSecs?: number, ip?: string): Promise<void> {
  const serverIp = ip || hetznerServerIp;
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;

  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_OPTS,
      `root@${serverIp}`,
      fullCmd,
    ],
    {
      stdio: [
        "pipe",
        "inherit",
        "inherit",
      ],
    },
  );

  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeout);
  const exitCode = await proc.exited;
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

export async function runServerCapture(cmd: string, timeoutSecs?: number, ip?: string): Promise<string> {
  const serverIp = ip || hetznerServerIp;
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;

  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_OPTS,
      `root@${serverIp}`,
      fullCmd,
    ],
    {
      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  );

  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, timeout);
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`run_server_capture failed (exit ${exitCode})`);
  }
  return stdout.trim();
}

export async function uploadFile(localPath: string, remotePath: string, ip?: string): Promise<void> {
  const serverIp = ip || hetznerServerIp;
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath)) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }

  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_OPTS,
      localPath,
      `root@${serverIp}:${remotePath}`,
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "pipe",
      ],
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string, ip?: string): Promise<number> {
  const serverIp = ip || hetznerServerIp;
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM=${term} PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${JSON.stringify(cmd)}`;

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTS, "-t", `root@${serverIp}`, fullCmd], {
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your Hetzner server (ID: ${hetznerServerId}) is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${HETZNER_DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");
  logInfo("To reconnect:");
  logInfo(`  ssh root@${serverIp}`);

  return exitCode;
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

export async function runWithRetry(
  maxAttempts: number,
  sleepSec: number,
  timeoutSecs: number,
  cmd: string,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runServer(cmd, timeoutSecs);
      return;
    } catch {
      logWarn(`Command failed (attempt ${attempt}/${maxAttempts}): ${cmd}`);
      if (attempt < maxAttempts) {
        await sleep(sleepSec * 1000);
      }
    }
  }
  logError(`Command failed after ${maxAttempts} attempts: ${cmd}`);
  throw new Error(`runWithRetry exhausted: ${cmd}`);
}

// ─── Server Name ─────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  if (process.env.HETZNER_SERVER_NAME) {
    const name = process.env.HETZNER_SERVER_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid HETZNER_SERVER_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using server name from environment: ${name}`);
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
    const answer = await prompt(`Hetzner server name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(serverId?: string): Promise<void> {
  const id = serverId || hetznerServerId;
  if (!id) {
    logError("destroy_server: no server ID provided");
    throw new Error("No server ID");
  }

  logStep(`Destroying Hetzner server ${id}...`);
  const resp = await hetznerApi("DELETE", `/servers/${id}`);
  const data = parseJson(resp);

  // Hetzner returns { action: {...} } on success. "error": null in action is normal.
  if (!data?.action) {
    const errMsg = rec(data?.error)?.message || "Unknown error";
    logError(`Failed to destroy server ${id}: ${errMsg}`);
    logWarn("The server may still be running and incurring charges.");
    logWarn(`Delete it manually at: ${HETZNER_DASHBOARD_URL}`);
    throw new Error("Server deletion failed");
  }
  logInfo(`Server ${id} destroyed`);
}

export async function listServers(): Promise<void> {
  const resp = await hetznerApi("GET", "/servers");
  const data = parseJson(resp);
  const servers = toObjectArray(data?.servers);

  if (servers.length === 0) {
    console.log("No servers found");
    return;
  }

  const pad = (str: string, n: number) => (str + " ".repeat(n)).slice(0, n);
  const str = (val: unknown, fallback = "N/A"): string =>
    typeof val === "string" ? val : (val != null ? String(val) : fallback);
  console.log(pad("NAME", 25) + pad("ID", 12) + pad("STATUS", 12) + pad("IP", 16) + pad("TYPE", 10));
  console.log("-".repeat(75));
  for (const s of servers) {
    const publicNet = rec(s.public_net);
    const ipv4 = rec(publicNet?.ipv4);
    const serverType = rec(s.server_type);
    console.log(
      pad(str(s.name).slice(0, 24), 25) +
        pad(str(s.id).slice(0, 11), 12) +
        pad(str(s.status).slice(0, 11), 12) +
        pad(str(ipv4?.ip).slice(0, 15), 16) +
        pad(str(serverType?.name).slice(0, 9), 10),
    );
  }
}
