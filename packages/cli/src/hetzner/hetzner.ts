// hetzner/hetzner.ts — Core Hetzner Cloud provider: API, auth, SSH, provisioning

import type { VMConnection } from "../history.js";
import type { CloudInitTier } from "../shared/agents";

import { mkdirSync, readFileSync } from "node:fs";
import { handleBillingError, isBillingError, showNonBillingError } from "../shared/billing-guidance";
import { getPackagesForTier, NODE_INSTALL_CMD, needsBun, needsNode } from "../shared/cloud-init";
import { parseJsonObj } from "../shared/parse";
import { getSpawnCloudConfigPath } from "../shared/paths";
import { asyncTryCatch, asyncTryCatchIf, isNetworkError, unwrapOr } from "../shared/result.js";
import {
  killWithTimeout,
  SSH_BASE_OPTS,
  SSH_INTERACTIVE_OPTS,
  waitForSsh as sharedWaitForSsh,
  sleep,
  spawnInteractive,
} from "../shared/ssh";
import { ensureSshKeys, getSshFingerprint, getSshKeyOpts } from "../shared/ssh-keys";
import { getErrorMessage, isNumber, isString, toObjectArray, toRecord } from "../shared/type-guards";
import {
  getServerNameFromEnv,
  jsonEscape,
  loadApiToken,
  logError,
  logInfo,
  logStep,
  logStepDone,
  logStepInline,
  logWarn,
  prompt,
  promptSpawnNameShared,
  sanitizeTermValue,
  selectFromList,
  validateRegionName,
} from "../shared/ui";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const HETZNER_DASHBOARD_URL = "https://console.hetzner.cloud/";

// ─── State ───────────────────────────────────────────────────────────────────

interface HetznerState {
  hcloudToken: string;
  serverId: string;
  serverIp: string;
}

const _state: HetznerState = {
  hcloudToken: "",
  serverId: "",
  serverIp: "",
};

/** Return SSH connection info for tunnel support. */
export function getConnectionInfo(): {
  host: string;
  user: string;
} {
  return {
    host: _state.serverIp,
    user: "root",
  };
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function hetznerApi(method: string, endpoint: string, body?: string, maxRetries = 3): Promise<string> {
  const url = `${HETZNER_API_BASE}${endpoint}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const r = await asyncTryCatch(async () => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_state.hcloudToken}`,
      };
      const opts: RequestInit = {
        method,
        headers,
      };
      if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        opts.body = body;
      }
      const resp = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await resp.text();

      if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
        logWarn(`API ${resp.status} (attempt ${attempt}/${maxRetries}), retrying in ${interval}s...`);
        await sleep(interval * 1000);
        interval = Math.min(interval * 2, 30);
        return undefined;
      }
      if (!resp.ok) {
        throw new Error(`Hetzner API error (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      }
      return text;
    });
    if (r.ok && r.data !== undefined) {
      return r.data;
    }
    if (r.ok) {
      // retry signal (status 429/5xx returned undefined)
      continue;
    }
    const e = r.error instanceof Error ? r.error : new Error(String(r.error));
    if (!isNetworkError(e) || attempt >= maxRetries) {
      throw r.error;
    }
    logWarn(`API request failed (attempt ${attempt}/${maxRetries}), retrying...`);
    await sleep(interval * 1000);
    interval = Math.min(interval * 2, 30);
  }
  throw new Error("hetznerApi: unreachable");
}

// ─── Token Persistence ───────────────────────────────────────────────────────

async function saveTokenToConfig(token: string): Promise<void> {
  const configPath = getSpawnCloudConfigPath("hetzner");
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

// ─── Token Validation ────────────────────────────────────────────────────────

async function testHcloudToken(): Promise<boolean> {
  if (!_state.hcloudToken) {
    return false;
  }
  return unwrapOr(
    await asyncTryCatchIf(isNetworkError, async () => {
      const resp = await hetznerApi("GET", "/servers?per_page=1", undefined, 1);
      const data = parseJsonObj(resp);
      // Hetzner returns { "error": { ... } } on auth failure.
      // Success responses may contain "error": null inside action objects,
      // so check for a real error object with a message.
      if (toRecord(data?.error)?.message) {
        return false;
      }
      return true;
    }),
    false,
  );
}

// ─── Authentication ──────────────────────────────────────────────────────────

export async function ensureHcloudToken(): Promise<void> {
  // 1. Env var
  if (process.env.HCLOUD_TOKEN) {
    _state.hcloudToken = process.env.HCLOUD_TOKEN.trim();
    if (await testHcloudToken()) {
      logInfo("Using Hetzner Cloud token from environment");
      await saveTokenToConfig(_state.hcloudToken);
      return;
    }
    logWarn("HCLOUD_TOKEN from environment is invalid");
    _state.hcloudToken = "";
  }

  // 2. Saved config
  const saved = loadApiToken("hetzner");
  if (saved) {
    _state.hcloudToken = saved;
    if (await testHcloudToken()) {
      logInfo("Using saved Hetzner Cloud token");
      return;
    }
    logWarn("Saved Hetzner token is invalid or expired");
    _state.hcloudToken = "";
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
    _state.hcloudToken = token.trim();
    if (await testHcloudToken()) {
      await saveTokenToConfig(_state.hcloudToken);
      logInfo("Hetzner Cloud token validated and saved");
      return;
    }
    logError("Token is invalid");
    _state.hcloudToken = "";
  }

  logError("No valid token after 3 attempts");
  throw new Error("Hetzner authentication failed");
}

// ─── SSH Key Management ──────────────────────────────────────────────────────

export async function ensureSshKey(): Promise<void> {
  const selectedKeys = await ensureSshKeys();

  // Fetch registered keys once before the loop to avoid N+1 API calls
  const resp = await hetznerApi("GET", "/ssh_keys");
  const data = parseJsonObj(resp);
  const sshKeys = toObjectArray(data?.ssh_keys);

  for (const key of selectedKeys) {
    const fingerprint = getSshFingerprint(key.pubPath);
    const pubKey = readFileSync(key.pubPath, "utf-8").trim();

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
    const regResult = await asyncTryCatch(() => hetznerApi("POST", "/ssh_keys", body));
    if (!regResult.ok) {
      // HTTP 409 "uniqueness_error" means the key already exists under a different
      // name. Hetzner's error message says "SSH key not unique" which the API layer
      // throws as an Error before we can parse the response body.
      const errMsg = getErrorMessage(regResult.error);
      if (/uniqueness_error|not unique|already/.test(errMsg)) {
        logInfo(`SSH key '${key.name}' already registered (different name)`);
        continue;
      }
      throw regResult.error;
    }
    const regResp = regResult.data;
    const regData = parseJsonObj(regResp);
    const regError = toRecord(regData?.error);
    const regErrMsg = isString(regError?.message) ? regError.message : "";
    if (regErrMsg) {
      // Key may already exist under a different name — non-fatal
      if (/already|uniqueness|not unique/.test(regErrMsg)) {
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
      "curl --proto '=https' -fsSL https://bun.sh/install | bash || true",
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

interface ServerTypeTier {
  id: string;
  label: string;
}

const SERVER_TYPES: ServerTypeTier[] = [
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

interface LocationOption {
  id: string;
  label: string;
}

const LOCATIONS: LocationOption[] = [
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

export const DEFAULT_LOCATION = "fsn1";

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
): Promise<VMConnection> {
  const sType = serverType || process.env.HETZNER_SERVER_TYPE || DEFAULT_SERVER_TYPE;
  const loc = location || process.env.HETZNER_LOCATION || "fsn1";
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
    const errMsg = String(toRecord(data?.error)?.message || "Unknown error");
    logError(`Failed to create Hetzner server: ${errMsg}`);

    if (isBillingError("hetzner", errMsg)) {
      const shouldRetry = await handleBillingError("hetzner");
      if (shouldRetry) {
        logStep("Retrying server creation...");
        const retryResp = await hetznerApi("POST", "/servers", body);
        const retryData = parseJsonObj(retryResp);
        const retryServer = toRecord(retryData?.server);
        if (retryServer) {
          _state.serverId = String(retryServer.id);
          const retryNet = toRecord(retryServer.public_net);
          const retryIpv4 = toRecord(retryNet?.ipv4);
          _state.serverIp = isString(retryIpv4?.ip) ? retryIpv4.ip : "";
          if (_state.serverId && _state.serverId !== "null" && _state.serverIp && _state.serverIp !== "null") {
            logInfo(`Server created: ID=${_state.serverId}, IP=${_state.serverIp}`);
            return {
              ip: _state.serverIp,
              user: "root",
              server_id: _state.serverId,
              server_name: name,
              cloud: "hetzner",
            };
          }
        }
        const retryErr = String(toRecord(retryData?.error)?.message || "Unknown error");
        logError(`Retry failed: ${retryErr}`);
      }
    } else {
      showNonBillingError("hetzner", [
        "Server type or location unavailable",
        "Server limit reached for your account",
      ]);
    }
    throw new Error(`Server creation failed: ${errMsg}`);
  }

  _state.serverId = String(server.id);
  const publicNet = toRecord(server.public_net);
  const ipv4 = toRecord(publicNet?.ipv4);
  _state.serverIp = isString(ipv4?.ip) ? ipv4.ip : "";

  if (!_state.serverId || _state.serverId === "null") {
    logError("Failed to extract server ID from API response");
    throw new Error("No server ID");
  }
  if (!_state.serverIp || _state.serverIp === "null") {
    logError("Failed to extract server IP from API response");
    throw new Error("No server IP");
  }

  logInfo(`Server created: ID=${_state.serverId}, IP=${_state.serverIp}`);
  return {
    ip: _state.serverIp,
    user: "root",
    server_id: _state.serverId,
    server_name: name,
    cloud: "hetzner",
  };
}

// ─── SSH Execution ───────────────────────────────────────────────────────────

export async function waitForCloudInit(ip?: string, maxAttempts = 60): Promise<void> {
  const serverIp = ip || _state.serverIp;
  const selectedKeys = await ensureSshKeys();
  const keyOpts = getSshKeyOpts(selectedKeys);
  await sharedWaitForSsh({
    host: serverIp,
    user: "root",
    maxAttempts: 36,
    extraSshOpts: keyOpts,
  });

  logStep("Waiting for cloud-init to complete...");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pollResult = await asyncTryCatch(async () => {
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
      // Per-process timeout: if the network drops during cloud-init polling,
      // `await proc.exited` blocks forever. Kill after 30s so the retry loop
      // can continue and the user isn't left with a hung CLI.
      const timer = setTimeout(() => killWithTimeout(proc), 30_000);
      // Drain both pipes before awaiting exit to prevent pipe buffer deadlock
      const pipeResult = await asyncTryCatch(async () => {
        const [stdout] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        return {
          stdout,
          exitCode,
        };
      });
      clearTimeout(timer);
      if (!pipeResult.ok) {
        throw pipeResult.error;
      }
      return pipeResult.data;
    });
    if (pollResult.ok && pollResult.data.exitCode === 0 && pollResult.data.stdout.includes("done")) {
      logStepDone();
      logInfo("Cloud-init complete");
      return;
    }
    if (attempt >= maxAttempts) {
      logStepDone();
      logWarn("Cloud-init marker not found, continuing anyway...");
      return;
    }
    logStepInline(`Cloud-init in progress (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
}

export async function runServer(cmd: string, timeoutSecs?: number, ip?: string): Promise<void> {
  const serverIp = ip || _state.serverIp;
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
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
  const runResult = await asyncTryCatch(() => proc.exited);
  clearTimeout(timer);
  if (!runResult.ok) {
    throw runResult.error;
  }
  if (runResult.data !== 0) {
    throw new Error(`run_server failed (exit ${runResult.data}): ${cmd}`);
  }
}

export async function uploadFile(localPath: string, remotePath: string, ip?: string): Promise<void> {
  const serverIp = ip || _state.serverIp;
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
  const timer = setTimeout(() => killWithTimeout(proc), 120_000);
  const uploadResult = await asyncTryCatch(() => proc.exited);
  clearTimeout(timer);
  if (!uploadResult.ok) {
    throw uploadResult.error;
  }
  if (uploadResult.data !== 0) {
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string, ip?: string): Promise<number> {
  const serverIp = ip || _state.serverIp;
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  // Single-quote escaping prevents premature shell expansion of $variables in cmd
  const shellEscapedCmd = cmd.replace(/'/g, "'\\''");
  const fullCmd = `export TERM=${term} PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c '${shellEscapedCmd}'`;

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
  logWarn(`Session ended. Your Hetzner server (ID: ${_state.serverId}) is still running.`);
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
  return getServerNameFromEnv("HETZNER_SERVER_NAME");
}

export async function promptSpawnName(): Promise<void> {
  return promptSpawnNameShared("Hetzner server");
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(serverId?: string): Promise<void> {
  const id = serverId || _state.serverId;
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
