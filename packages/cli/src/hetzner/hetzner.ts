// hetzner/hetzner.ts — Core Hetzner Cloud provider: API, auth, SSH, provisioning

import type { CloudInstance, VMConnection } from "../history.js";
import type { CloudInitTier } from "../shared/agents.js";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getErrorMessage, isNumber, isString, toObjectArray, toRecord } from "@openrouter/spawn-shared";
import { handleBillingError, isBillingError, showNonBillingError } from "../shared/billing-guidance.js";
import { getPackagesForTier, NODE_INSTALL_CMD, needsBun, needsNode } from "../shared/cloud-init.js";
import { parseJsonObj } from "../shared/parse.js";
import { getSpawnCloudConfigPath } from "../shared/paths.js";
import { asyncTryCatch, asyncTryCatchIf, isNetworkError, unwrapOr } from "../shared/result.js";
import {
  killWithTimeout,
  SSH_BASE_OPTS,
  SSH_INTERACTIVE_OPTS,
  waitForSsh as sharedWaitForSsh,
  sleep,
  spawnInteractive,
  validateRemotePath,
  waitForSshSnapshotBoot,
} from "../shared/ssh.js";
import { ensureSshKeys, getSshFingerprint, getSshKeyOpts } from "../shared/ssh-keys.js";
import {
  getServerNameFromEnv,
  jsonEscape,
  loadApiToken,
  logDebug,
  logError,
  logInfo,
  logStep,
  logStepDone,
  logStepInline,
  logWarn,
  prompt,
  promptSpawnNameShared,
  retryOrQuit,
  sanitizeTermValue,
  selectFromList,
  shellQuote,
  validateRegionName,
} from "../shared/ui.js";
import { hetznerBilling } from "./billing.js";

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

/**
 * Paginate a Hetzner GET collection endpoint.
 * Returns all items from the given `key` across all pages.
 */
async function hetznerGetAll(endpoint: string, key: string): Promise<Record<string, unknown>[]> {
  const sep = endpoint.includes("?") ? "&" : "?";
  let page = 1;
  const all: Record<string, unknown>[] = [];
  for (;;) {
    const resp = await hetznerApi("GET", `${endpoint}${sep}per_page=50&page=${page}`);
    const data = parseJsonObj(resp);
    const items = toObjectArray(data?.[key]);
    for (const item of items) {
      all.push(toRecord(item) ?? {});
    }
    // Check if there's a next page
    const meta = toRecord(toRecord(data?.meta)?.pagination);
    const nextPage = isNumber(meta?.next_page) ? meta.next_page : 0;
    if (nextPage <= page || nextPage === 0) {
      break;
    }
    page = nextPage;
  }
  return all;
}

// ─── Token Persistence ───────────────────────────────────────────────────────

async function saveTokenToConfig(token: string): Promise<void> {
  const configPath = getSpawnCloudConfigPath("hetzner");
  const dir = dirname(configPath);
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  const escaped = jsonEscape(token);
  writeFileSync(configPath, `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`, {
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

  // 3. Manual entry (retry loop — never exits unless user says no)
  for (;;) {
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
    await retryOrQuit("Enter a new Hetzner token?");
  }
}

// ─── SSH Key Management ──────────────────────────────────────────────────────

export async function ensureSshKey(): Promise<void> {
  const selectedKeys = await ensureSshKeys();

  // Fetch all registered keys (paginated) once before the loop to avoid N+1 API calls
  const sshKeys = await hetznerGetAll("/ssh_keys", "ssh_keys");

  for (const key of selectedKeys) {
    const fingerprint = getSshFingerprint(key.pubPath);
    if (!fingerprint) {
      logWarn(`Could not determine fingerprint for SSH key '${key.name}'`);
      continue;
    }
    const pubKey = readFileSync(key.pubPath, "utf-8").trim();

    const alreadyRegistered = sshKeys.some((k) => k.fingerprint === fingerprint);

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
  const quotedPackages = packages.map((p) => shellQuote(p)).join(" ");
  const lines = [
    "#!/bin/bash",
    "export HOME=/root",
    "export DEBIAN_FRONTEND=noninteractive",
    "# Guarantee the cloud-init marker is written on exit (success, failure, or signal)",
    "trap 'touch /home/ubuntu/.cloud-init-complete 2>/dev/null; touch /root/.cloud-init-complete' EXIT",
    "apt-get update -y || true",
    `apt-get install -y --no-install-recommends ${quotedPackages} || true`,
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

const FALLBACK_LOCATIONS: LocationOption[] = [
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

/**
 * Fetch available locations from the Hetzner API.
 * Falls back to a hardcoded list if the API call fails.
 */
async function fetchLocations(): Promise<LocationOption[]> {
  const result = await asyncTryCatch(async () => {
    const items = await hetznerGetAll("/locations", "locations");
    const locs: LocationOption[] = [];
    for (const item of items) {
      const name = isString(item.name) ? item.name : "";
      const city = isString(item.city) ? item.city : "";
      const country = isString(item.country) ? item.country : "";
      const description = isString(item.description) ? item.description : "";
      if (!name) {
        continue;
      }
      // Build a label like "Falkenstein, DE" or fall back to the API description
      const label = city && country ? `${city}, ${country}` : description || name;
      locs.push({
        id: name,
        label,
      });
    }
    return locs;
  });
  if (result.ok && result.data.length > 0) {
    return result.data;
  }
  logWarn("Could not fetch locations from Hetzner API, using built-in list");
  return FALLBACK_LOCATIONS;
}

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

export async function promptLocation(excludeLocations?: string[]): Promise<string> {
  if (process.env.HETZNER_LOCATION && !excludeLocations?.length) {
    logInfo(`Using location from environment: ${process.env.HETZNER_LOCATION}`);
    return process.env.HETZNER_LOCATION;
  }

  // Fetch dynamic locations from the API (falls back to hardcoded list)
  let locations = await fetchLocations();

  // Filter out locations that already failed (e.g. disabled by Hetzner)
  if (excludeLocations?.length) {
    locations = locations.filter((l) => !excludeLocations.includes(l.id));
    if (locations.length === 0) {
      logError("No available Hetzner locations remaining");
      throw new Error("All locations unavailable");
    }
  }

  // Non-custom and non-interactive modes: pick the first available default
  if ((process.env.SPAWN_CUSTOM !== "1" || process.env.SPAWN_NON_INTERACTIVE === "1") && !excludeLocations?.length) {
    // Prefer DEFAULT_LOCATION if it exists in the list, otherwise first available
    const hasDefault = locations.some((l) => l.id === DEFAULT_LOCATION);
    return hasDefault ? DEFAULT_LOCATION : locations[0].id;
  }

  process.stderr.write("\n");
  const items = locations.map((l) => `${l.id}|${l.label}`);
  const defaultLoc = locations.some((l) => l.id === DEFAULT_LOCATION) ? DEFAULT_LOCATION : locations[0].id;
  return selectFromList(items, "Hetzner location", defaultLoc);
}

// ─── SSH-Only Wait (for docker boots) ───────────────────────────────────────

export async function waitForSshOnly(ip?: string): Promise<void> {
  const keyOpts = getSshKeyOpts(await ensureSshKeys());
  await waitForSshSnapshotBoot(ip ?? _state.serverIp, keyOpts);
}

// ─── Provisioning ────────────────────────────────────────────────────────────

/** Check if a Hetzner API error indicates a location is unavailable (HTTP 412 resource_unavailable). */
function isLocationUnavailableError(errMsg: string): boolean {
  return /resource_unavailable|location disabled|location.*unavailable/i.test(errMsg);
}

/** Check if a Hetzner API error indicates a resource limit was exceeded (e.g. primary_ip_limit). */
export function isResourceLimitError(errMsg: string): boolean {
  return /resource_limit_exceeded|primary_ip_limit/i.test(errMsg);
}

/**
 * Clean up orphaned Hetzner Primary IPs (not attached to any server).
 * These accumulate from failed/leaked server provisioning runs and count toward
 * the account's primary_ip_limit quota. Returns the number of IPs deleted.
 */
export async function cleanupOrphanedPrimaryIps(): Promise<number> {
  const allIps = await hetznerGetAll("/primary_ips", "primary_ips");
  let deleted = 0;
  for (const ip of allIps) {
    // assignee_id is null/0 when the IP is not attached to a server
    const assigneeId = isNumber(ip.assignee_id) ? ip.assignee_id : 0;
    if (assigneeId !== 0) {
      continue;
    }
    const ipId = isNumber(ip.id) ? ip.id : 0;
    if (ipId === 0) {
      continue;
    }
    const ipAddr = isString(ip.ip) ? ip.ip : `ID:${ipId}`;
    const r = await asyncTryCatch(() => hetznerApi("DELETE", `/primary_ips/${ipId}`));
    if (r.ok) {
      logInfo(`Deleted orphaned Primary IP ${ipAddr}`);
      deleted = deleted + 1;
    } else {
      logWarn(`Could not delete Primary IP ${ipAddr}: ${getErrorMessage(r.error)}`);
    }
  }
  return deleted;
}

export async function createServer(
  name: string,
  serverType?: string,
  location?: string,
  tier?: CloudInitTier,
  _snapshotId?: string,
  dockerImage?: string,
): Promise<VMConnection> {
  const sType = serverType || process.env.HETZNER_SERVER_TYPE || DEFAULT_SERVER_TYPE;
  let loc = location || process.env.HETZNER_LOCATION || DEFAULT_LOCATION;
  const image: string = dockerImage ?? "ubuntu-24.04";
  const imageLabel: string = dockerImage ?? "ubuntu-24.04";

  if (!validateRegionName(loc)) {
    logError("Invalid HETZNER_LOCATION");
    throw new Error("Invalid location");
  }

  // Get all SSH key IDs once (paginated to avoid missing keys beyond page 1)
  const allKeys = await hetznerGetAll("/ssh_keys", "ssh_keys");
  const sshKeyIds: number[] = allKeys.map((k) => (isNumber(k.id) ? k.id : 0)).filter(Boolean);
  const userdata = getCloudInitUserdata(tier);

  // Track locations that failed so the user isn't offered them again
  const failedLocations: string[] = [];
  const maxLocationRetries = 3;
  // Track whether we've already attempted a resource-limit cleanup+retry
  let resourceLimitRetried = false;

  for (let attempt = 0; attempt <= maxLocationRetries; attempt++) {
    logStep(`Creating Hetzner server '${name}' (type: ${sType}, location: ${loc}, image: ${imageLabel})...`);

    const body = JSON.stringify({
      name,
      server_type: sType,
      location: loc,
      image,
      ssh_keys: sshKeyIds,
      user_data: userdata,
      start_after_create: true,
    });

    const createResult = await asyncTryCatch(() => hetznerApi("POST", "/servers", body));

    // Handle API-level errors (HTTP 412, etc.) that throw before we get JSON
    if (!createResult.ok) {
      const errMsg = getErrorMessage(createResult.error);

      if (isLocationUnavailableError(errMsg) && process.env.SPAWN_NON_INTERACTIVE !== "1") {
        failedLocations.push(loc);
        logWarn(`Location '${loc}' is currently unavailable. Please pick a different location.`);
        const newLoc = await promptLocation(failedLocations);
        if (newLoc === loc) {
          throw createResult.error;
        }
        loc = newLoc;
        continue;
      }

      // Resource limit (e.g. primary_ip_limit) — try cleaning up orphaned IPs, then retry once
      if (isResourceLimitError(errMsg) && !resourceLimitRetried) {
        resourceLimitRetried = true;
        logWarn("Hetzner resource limit exceeded (primary_ip_limit). Cleaning up orphaned Primary IPs...");
        const cleaned = await asyncTryCatch(() => cleanupOrphanedPrimaryIps());
        const count = cleaned.ok ? cleaned.data : 0;
        if (count > 0) {
          logInfo(`Cleaned up ${count} orphaned Primary IP(s). Retrying server creation...`);
          continue;
        }
        logError("No orphaned Primary IPs found to clean up.");
        logWarn("Your Hetzner account has reached its Primary IP limit.");
        logWarn("To fix this:");
        logWarn("  1. Delete unused servers in the Hetzner Console");
        logWarn("  2. Go to Networking > Primary IPs and delete unattached IPs");
        logWarn("  3. Or request a quota increase at: https://console.hetzner.cloud/limits");
        throw createResult.error;
      }

      throw createResult.error;
    }

    const data = parseJsonObj(createResult.data);

    // Hetzner success responses contain "error": null in action objects,
    // so check for presence of .server object, not absence of "error" string.
    const server = toRecord(data?.server);
    if (!server) {
      const errMsg = String(toRecord(data?.error)?.message || "Unknown error");
      const errCode = String(toRecord(data?.error)?.code || "");

      // Location unavailable — let user re-pick
      if (
        (isLocationUnavailableError(errMsg) || isLocationUnavailableError(errCode)) &&
        process.env.SPAWN_NON_INTERACTIVE !== "1"
      ) {
        failedLocations.push(loc);
        logWarn(`Location '${loc}' is currently unavailable. Please pick a different location.`);
        const newLoc = await promptLocation(failedLocations);
        if (newLoc === loc) {
          throw new Error(`Server creation failed: ${errMsg}`);
        }
        loc = newLoc;
        continue;
      }

      // Resource limit (e.g. primary_ip_limit) — try cleaning up orphaned IPs, then retry once
      if ((isResourceLimitError(errMsg) || isResourceLimitError(errCode)) && !resourceLimitRetried) {
        resourceLimitRetried = true;
        logWarn("Hetzner resource limit exceeded (primary_ip_limit). Cleaning up orphaned Primary IPs...");
        const cleaned = await asyncTryCatch(() => cleanupOrphanedPrimaryIps());
        const count = cleaned.ok ? cleaned.data : 0;
        if (count > 0) {
          logInfo(`Cleaned up ${count} orphaned Primary IP(s). Retrying server creation...`);
          continue;
        }
        logError("No orphaned Primary IPs found to clean up.");
        logWarn("Your Hetzner account has reached its Primary IP limit.");
        logWarn("To fix this:");
        logWarn("  1. Delete unused servers in the Hetzner Console");
        logWarn("  2. Go to Networking > Primary IPs and delete unattached IPs");
        logWarn("  3. Or request a quota increase at: https://console.hetzner.cloud/limits");
        throw new Error(`Server creation failed: ${errMsg}`);
      }

      logError(`Failed to create Hetzner server: ${errMsg}`);

      if (isBillingError(hetznerBilling, errMsg)) {
        const shouldRetry = await handleBillingError(hetznerBilling);
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
        showNonBillingError(hetznerBilling, [
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

  throw new Error("Server creation failed: too many location retries");
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
  if (!cmd || /\0/.test(cmd)) {
    throw new Error("Invalid command: must be non-empty and must not contain null bytes");
  }
  const serverIp = ip || _state.serverIp;
  const fullCmd = `export PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && bash -c ${shellQuote(cmd)}`;
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
  // Drain both pipes to prevent buffer deadlocks, then await exit
  const runResult = await asyncTryCatch(async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return {
      stdout,
      stderr,
      exitCode,
    };
  });
  clearTimeout(timer);
  if (!runResult.ok) {
    throw runResult.error;
  }
  if (runResult.data.exitCode !== 0) {
    // Show captured stderr on failure for debugging
    const stderr = runResult.data.stderr.trim();
    if (stderr) {
      logDebug(stderr);
    }
    throw new Error(`run_server failed (exit ${runResult.data.exitCode}): ${cmd}`);
  }
}

export async function uploadFile(localPath: string, remotePath: string, ip?: string): Promise<void> {
  const serverIp = ip || _state.serverIp;
  const normalizedRemote = validateRemotePath(remotePath, /^[a-zA-Z0-9/_.~-]+$/);

  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      localPath,
      `root@${serverIp}:${normalizedRemote}`,
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

export async function downloadFile(remotePath: string, localPath: string, ip?: string): Promise<void> {
  const serverIp = ip || _state.serverIp;
  const expandedRemote = remotePath.replace(/^\$HOME\//, "~/");
  const normalizedRemote = validateRemotePath(expandedRemote, /^[a-zA-Z0-9/_.~-]+$/);

  const keyOpts = getSshKeyOpts(await ensureSshKeys());

  const proc = Bun.spawn(
    [
      "scp",
      ...SSH_BASE_OPTS,
      ...keyOpts,
      `root@${serverIp}:${normalizedRemote}`,
      localPath,
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
  const dlResult = await asyncTryCatch(() => proc.exited);
  clearTimeout(timer);
  if (!dlResult.ok) {
    throw dlResult.error;
  }
  if (dlResult.data !== 0) {
    throw new Error(`download_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string, ip?: string): Promise<number> {
  if (!cmd || /\0/.test(cmd)) {
    throw new Error("Invalid command: must be non-empty and must not contain null bytes");
  }
  const serverIp = ip || _state.serverIp;
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM='${term}' LANG='C.UTF-8' LC_ALL='C.UTF-8' PATH="$HOME/.npm-global/bin:$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${shellQuote(cmd)}`;

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

/** Fetch the current public IP of an existing Hetzner server. Returns null if the server no longer exists. */
export async function getServerIp(serverId: string): Promise<string | null> {
  const r = await asyncTryCatch(() => hetznerApi("GET", `/servers/${serverId}`, undefined, 1));
  if (!r.ok) {
    const msg = getErrorMessage(r.error);
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      return null;
    }
    throw r.error;
  }
  const data = parseJsonObj(r.data);
  const server = toRecord(data?.server);
  if (!server) {
    return null;
  }
  const publicNet = toRecord(server.public_net);
  const ipv4 = toRecord(publicNet?.ipv4);
  return isString(ipv4?.ip) ? ipv4.ip : null;
}

/** List all Hetzner servers. Returns simplified instance info for the remap picker. */
export async function listServers(): Promise<CloudInstance[]> {
  const servers = await hetznerGetAll("/servers", "servers");
  const results: CloudInstance[] = [];
  for (const s of servers) {
    const publicNet = toRecord(s.public_net);
    const ipv4 = toRecord(publicNet?.ipv4);
    const ip = isString(ipv4?.ip) ? ipv4.ip : "";
    results.push({
      id: String(s.id ?? ""),
      name: isString(s.name) ? s.name : "",
      ip,
      status: isString(s.status) ? s.status : "",
    });
  }
  return results;
}

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
