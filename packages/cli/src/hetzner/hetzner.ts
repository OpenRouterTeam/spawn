// hetzner/hetzner.ts — Core Hetzner Cloud provider: API, auth, SSH, provisioning

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  selectFromList,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import {
  SSH_BASE_OPTS,
  SSH_INTERACTIVE_OPTS,
  sleep,
  waitForSsh as sharedWaitForSsh,
  killWithTimeout,
  spawnInteractive,
} from "../shared/ssh";
import { ensureSshKeys, getSshFingerprint, getSshKeyOpts } from "../shared/ssh-keys";
import { parseJsonObj, isString, isNumber, toObjectArray, toRecord } from "@openrouter/spawn-shared";
import { saveVmConnection } from "../history.js";

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

// ─── Token Persistence ───────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(process.env.HOME || homedir(), ".config", "spawn", "hetzner.json");
}

async function saveTokenToConfig(token: string): Promise<void> {
  const configPath = getConfigPath();
  const dir = configPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  const escaped = jsonEscape(token);
  await Bun.write(configPath, `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`, {
    mode: 0o600,
  });
}

function loadTokenFromConfig(): string | null {
  try {
    const data = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
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
    const data = parseJsonObj(resp);
    // Hetzner returns { "error": { ... } } on auth failure.
    // Success responses may contain "error": null inside action objects,
    // so check for a real error object with a message.
    if (toRecord(data?.error)?.message) {
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

export async function ensureSshKey(): Promise<void> {
  const selectedKeys = await ensureSshKeys();

  for (const key of selectedKeys) {
    const fingerprint = getSshFingerprint(key.pubPath);
    const pubKey = readFileSync(key.pubPath, "utf-8").trim();

    // Check if key is already registered
    const resp = await hetznerApi("GET", "/ssh_keys");
    const data = parseJsonObj(resp);
    const sshKeys = toObjectArray(data?.ssh_keys);

    const alreadyRegistered = sshKeys.some((k) => fingerprint && k.fingerprint === fingerprint);

    if (alreadyRegistered) {
      logInfo(`SSH key '${key.name}' already registered with Hetzner`);
      continue;
    }

    // Register key
    logStep(`Registering SSH key '${key.name}' with Hetzner...`);
    const keyName = `spawn-${key.name}-${Date.now()}`;
    const body = JSON.stringify({
      name: keyName,
      public_key: pubKey,
    });
    const regResp = await hetznerApi("POST", "/ssh_keys", body);
    const regData = parseJsonObj(regResp);
    const regError = toRecord(regData?.error);
    const regErrMsg = isString(regError?.message) ? regError.message : "";
    if (regErrMsg) {
      // Key may already exist under a different name — non-fatal
      if (/already/.test(regErrMsg)) {
        logInfo(`SSH key '${key.name}' already registered (different name)`);
        continue;
      }
      logError(`Failed to register SSH key '${key.name}': ${regErrMsg}`);
      throw new Error("SSH key registration failed");
    }
    logInfo(`SSH key '${key.name}' registered with Hetzner`);
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

// ─── Server Type Options ─────────────────────────────────────────────────────

export interface ServerTypeTier {
  id: string;
  label: string;
}

export const SERVER_TYPES: ServerTypeTier[] = [
  {
    id: "cx23",
    label: "cx23 \u00b7 2 vCPU \u00b7 4 GB \u00b7 40 GB (~\u20AC3.49/mo, EU only)",
  },
  {
    id: "cx33",
    label: "cx33 \u00b7 4 vCPU \u00b7 8 GB \u00b7 80 GB (~\u20AC6.49/mo, EU only)",
  },
  {
    id: "cx43",
    label: "cx43 \u00b7 8 vCPU \u00b7 16 GB \u00b7 160 GB (~\u20AC14.49/mo, EU only)",
  },
  {
    id: "cx53",
    label: "cx53 \u00b7 16 vCPU \u00b7 32 GB \u00b7 320 GB (~\u20AC28.49/mo, EU only)",
  },
  {
    id: "cpx22",
    label: "cpx22 \u00b7 3 AMD vCPU \u00b7 4 GB \u00b7 80 GB (~\u20AC5.49/mo)",
  },
  {
    id: "cpx32",
    label: "cpx32 \u00b7 4 AMD vCPU \u00b7 8 GB \u00b7 160 GB (~\u20AC9.49/mo)",
  },
];

export const DEFAULT_SERVER_TYPE = "cx23";

// ─── Location Options ────────────────────────────────────────────────────────

export interface LocationOption {
  id: string;
  label: string;
}

export const LOCATIONS: LocationOption[] = [
  {
    id: "fsn1",
    label: "Falkenstein, Germany",
  },
  {
    id: "nbg1",
    label: "Nuremberg, Germany",
  },
  {
    id: "hel1",
    label: "Helsinki, Finland",
  },
  {
    id: "ash",
    label: "Ashburn, VA, US",
  },
  {
    id: "hil",
    label: "Hillsboro, OR, US",
  },
];

export const DEFAULT_LOCATION = "nbg1";

// ─── Interactive Pickers ─────────────────────────────────────────────────────

export async function promptServerType(): Promise<string> {
  if (process.env.HETZNER_SERVER_TYPE) {
    logInfo(`Using server type from environment: ${process.env.HETZNER_SERVER_TYPE}`);
    return process.env.HETZNER_SERVER_TYPE;
  }

  if (process.env.SPAWN_CUSTOM !== "1") {
    return DEFAULT_SERVER_TYPE;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_SERVER_TYPE;
  }

  process.stderr.write("\n");
  const items = SERVER_TYPES.map((t) => `${t.id}|${t.label}`);
  return selectFromList(items, "Hetzner server type", DEFAULT_SERVER_TYPE);
}

export async function promptLocation(): Promise<string> {
  if (process.env.HETZNER_LOCATION) {
    logInfo(`Using location from environment: ${process.env.HETZNER_LOCATION}`);
    return process.env.HETZNER_LOCATION;
  }

  if (process.env.SPAWN_CUSTOM !== "1") {
    return DEFAULT_LOCATION;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_LOCATION;
  }

  process.stderr.write("\n");
  const items = LOCATIONS.map((l) => `${l.id}|${l.label}`);
  return selectFromList(items, "Hetzner location", DEFAULT_LOCATION);
}

// ─── Provisioning ────────────────────────────────────────────────────────────

export async function createServer(
  name: string,
  serverType?: string,
  location?: string,
  tier?: CloudInitTier,
): Promise<void> {
  const sType = serverType || process.env.HETZNER_SERVER_TYPE || DEFAULT_SERVER_TYPE;
  const loc = location || process.env.HETZNER_LOCATION || "nbg1";
  const image = "ubuntu-24.04";

  if (!validateRegionName(loc)) {
    logError("Invalid HETZNER_LOCATION");
    throw new Error("Invalid location");
  }

  logStep(`Creating Hetzner server '${name}' (type: ${sType}, location: ${loc})...`);

  // Get all SSH key IDs
  const keysResp = await hetznerApi("GET", "/ssh_keys");
  const keysData = parseJsonObj(keysResp);
  const sshKeyIds: number[] = toObjectArray(keysData?.ssh_keys)
    .map((k) => (isNumber(k.id) ? k.id : 0))
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
  const data = parseJsonObj(resp);

  // Hetzner success responses contain "error": null in action objects,
  // so check for presence of .server object, not absence of "error" string.
  const server = toRecord(data?.server);
  if (!server) {
    const errMsg = toRecord(data?.error)?.message || "Unknown error";
    logError(`Failed to create Hetzner server: ${errMsg}`);
    logWarn("Common issues:");
    logWarn("  - Insufficient account balance or payment method required");
    logWarn("  - Server type/location unavailable");
    logWarn("  - Server limit reached for your account");
    logWarn(`Check your dashboard: ${HETZNER_DASHBOARD_URL}`);
    throw new Error(`Server creation failed: ${errMsg}`);
  }

  hetznerServerId = String(server.id);
  const publicNet = toRecord(server.public_net);
  const ipv4 = toRecord(publicNet?.ipv4);
  hetznerServerIp = isString(ipv4?.ip) ? ipv4.ip : "";

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

export async function waitForCloudInit(ip?: string, _maxAttempts = 60): Promise<void> {
  const serverIp = ip || hetznerServerIp;
  const selectedKeys = await ensureSshKeys();
  const keyOpts = getSshKeyOpts(selectedKeys);
  await sharedWaitForSsh({
    host: serverIp,
    user: "root",
    maxAttempts: 36,
    extraSshOpts: keyOpts,
  });

  logStep("Waiting for cloud-init to complete...");
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "ssh",
          ...SSH_BASE_OPTS,
          ...keyOpts,
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
      // Drain both pipes before awaiting exit to prevent pipe buffer deadlock
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
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
  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `root@${serverIp}`,
      fullCmd,
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
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

export async function runServerCapture(cmd: string, timeoutSecs?: number, ip?: string): Promise<string> {
  const serverIp = ip || hetznerServerIp;
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `root@${serverIp}`,
      fullCmd,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );

  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => killWithTimeout(proc), timeout);
  // Drain both pipes before awaiting exit to prevent pipe buffer deadlock
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`run_server_capture failed (exit ${exitCode})`);
  }
  return stdout.trim();
}

export async function uploadFile(localPath: string, remotePath: string, ip?: string): Promise<void> {
  const serverIp = ip || hetznerServerIp;
  if (
    !/^[a-zA-Z0-9/_.~-]+$/.test(remotePath) ||
    remotePath.includes("..") ||
    remotePath.split("/").some((s) => s.startsWith("-"))
  ) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }

  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      localPath,
      `root@${serverIp}:${remotePath}`,
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
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string, ip?: string): Promise<number> {
  const serverIp = ip || hetznerServerIp;
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  // Single-quote escaping prevents premature shell expansion of $variables in cmd
  const shellEscapedCmd = cmd.replace(/'/g, "'\\''");
  const fullCmd = `export TERM=${term} PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c '${shellEscapedCmd}'`;

  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const exitCode = spawnInteractive([
    "ssh",
    ...SSH_INTERACTIVE_OPTS,
    ...keyOpts,
    `root@${serverIp}`,
    fullCmd,
  ]);

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
  const data = parseJsonObj(resp);

  // Hetzner returns { action: {...} } on success. "error": null in action is normal.
  if (!data?.action) {
    const errMsg = toRecord(data?.error)?.message || "Unknown error";
    logError(`Failed to destroy server ${id}: ${errMsg}`);
    logWarn("The server may still be running and incurring charges.");
    logWarn(`Delete it manually at: ${HETZNER_DASHBOARD_URL}`);
    throw new Error("Server deletion failed");
  }
  logInfo(`Server ${id} destroyed`);
}
