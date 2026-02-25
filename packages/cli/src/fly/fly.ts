// fly/lib/fly.ts — Core Fly.io provider: API, auth, orgs, provisioning, execution

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  selectFromList,
  jsonEscape,
  validateServerName,
  validateRegionName,
  toKebabCase,
  defaultSpawnName,
  sanitizeTermValue,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import * as v from "valibot";
import { parseJsonWith, parseJsonRaw, isString, isNumber, toObjectArray } from "@openrouter/spawn-shared";
import { saveVmConnection } from "../history.js";

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_DASHBOARD_URL = "https://fly.io/dashboard";

// ─── VM Size Tiers ──────────────────────────────────────────────────────────

export type CpuKind = "shared" | "performance";

export interface VmTier {
  id: string;
  cpuKind: CpuKind;
  cpus: number;
  memoryMb: number;
  label: string;
}

export const FLY_VM_TIERS: VmTier[] = [
  {
    id: "shared-cpu-1x",
    cpuKind: "shared",
    cpus: 1,
    memoryMb: 1024,
    label: "1 shared vCPU, 1 GB (~$3/mo)",
  },
  {
    id: "shared-cpu-2x",
    cpuKind: "shared",
    cpus: 2,
    memoryMb: 4096,
    label: "2 shared vCPUs, 4 GB (~$12/mo)",
  },
  {
    id: "shared-cpu-4x",
    cpuKind: "shared",
    cpus: 4,
    memoryMb: 8192,
    label: "4 shared vCPUs, 8 GB (~$51/mo)",
  },
  {
    id: "performance-1x",
    cpuKind: "performance",
    cpus: 1,
    memoryMb: 2048,
    label: "1 dedicated vCPU, 2 GB (~$32/mo)",
  },
  {
    id: "performance-2x",
    cpuKind: "performance",
    cpus: 2,
    memoryMb: 4096,
    label: "2 dedicated vCPUs, 4 GB (~$63/mo)",
  },
  {
    id: "performance-4x",
    cpuKind: "performance",
    cpus: 4,
    memoryMb: 8192,
    label: "4 dedicated vCPUs, 8 GB (~$126/mo)",
  },
];

export const DEFAULT_VM_TIER = FLY_VM_TIERS[4]; // performance-2x

// ─── Server Options ─────────────────────────────────────────────────────────

export interface ServerOptions {
  cpuKind: CpuKind;
  cpus: number;
  memoryMb: number;
  volumeId?: string;
  newVolumeSizeGb?: number;
}

// ─── State ───────────────────────────────────────────────────────────────────
let flyApiToken = "";
let flyOrg = "";
let flyMachineId = "";
let flyAppName = "";

export function getState() {
  return {
    flyApiToken,
    flyOrg,
    flyMachineId,
    flyAppName,
  };
}

export function setOrg(org: string) {
  flyOrg = org;
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function flyApi(method: string, endpoint: string, body?: string, maxRetries = 3): Promise<string> {
  const url = `${FLY_API_BASE}${endpoint}`;
  const authHeader = flyApiToken.startsWith("FlyV1 ") ? flyApiToken : `Bearer ${flyApiToken}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: authHeader,
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

      // Retry on 429 / 5xx
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
  throw new Error("flyApi: unreachable");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const LooseObject = v.record(v.string(), v.unknown());

function parseJson(text: string): Record<string, unknown> | null {
  return parseJsonWith(text, LooseObject);
}

function hasError(text: string): boolean {
  return text.includes('"error"') || text.includes('"errors"');
}

function getCmd(): string | null {
  // Check PATH first
  for (const name of [
    "fly",
    "flyctl",
  ]) {
    if (
      Bun.spawnSync(
        [
          "which",
          name,
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
      return name;
    }
  }
  // Bun.spawnSync inherits the original PATH, not process.env mutations.
  // Check the default install location directly.
  const flyBin = `${process.env.HOME}/.fly/bin`;
  for (const name of [
    "fly",
    "flyctl",
  ]) {
    const fullPath = `${flyBin}/${name}`;
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// ─── Token Sanitization ─────────────────────────────────────────────────────

export function sanitizeFlyToken(raw: string): string {
  let t = raw.replace(/[\n\r]/g, "").trim();
  if (t.includes("FlyV1 ")) {
    // Already prefixed — extract everything after "FlyV1 "
    t = "FlyV1 " + t.split("FlyV1 ").pop()!;
  } else if (t.includes("fm2_")) {
    // Macaroon token — may have comma-separated discharge tokens (fm2_xxx,fm2_yyy,fo1_zzz).
    // Extract from the first fm2_ to end-of-string, preserving all segments.
    const m = t.match(/(fm2_\S+)/);
    if (m) {
      t = "FlyV1 " + m[1];
    }
  } else if (t.startsWith("m2.")) {
    t = "FlyV1 " + t;
  }
  return t;
}

// ─── Token Validation ────────────────────────────────────────────────────────

async function testFlyToken(): Promise<boolean> {
  if (!flyApiToken) {
    return false;
  }
  try {
    const org = flyOrg || "personal";
    const resp = await flyApi("GET", `/apps?org_slug=${org}`, undefined, 1);
    if (!hasError(resp)) {
      return true;
    }
  } catch {
    // fall through
  }
  // Fallback: user API (OAuth/personal tokens)
  try {
    const authHeader = flyApiToken.startsWith("FlyV1 ") ? flyApiToken : `Bearer ${flyApiToken}`;
    const resp = await fetch("https://api.fly.io/v1/user", {
      headers: {
        Authorization: authHeader,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text && !hasError(text)) {
        return true;
      }
    }
  } catch {
    // fall through
  }
  return false;
}

// ─── Token Persistence ───────────────────────────────────────────────────────

const FLY_CONFIG_PATH = `${process.env.HOME}/.config/spawn/fly.json`;

async function saveTokenToConfig(token: string): Promise<void> {
  const dir = FLY_CONFIG_PATH.replace(/\/[^/]+$/, "");
  await Bun.spawn([
    "mkdir",
    "-p",
    dir,
  ]).exited;
  const escaped = jsonEscape(token);
  await Bun.write(FLY_CONFIG_PATH, `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`, {
    mode: 0o600,
  });
}

/** Sync the resolved token to process.env so fly CLI subprocesses (ssh console) can authenticate. */
function syncTokenToEnv(): void {
  if (flyApiToken) {
    process.env.FLY_API_TOKEN = flyApiToken;
  }
}

function loadTokenFromConfig(): string | null {
  try {
    const data = JSON.parse(readFileSync(FLY_CONFIG_PATH, "utf-8"));
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

// ─── Authentication ──────────────────────────────────────────────────────────

export async function ensureFlyCli(): Promise<void> {
  if (getCmd()) {
    logInfo("flyctl CLI available");
    return;
  }
  logStep("Installing flyctl CLI...");
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      "curl -L https://fly.io/install.sh | sh",
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
    logError("Failed to install flyctl CLI");
    logError("Install manually: curl -L https://fly.io/install.sh | sh");
    throw new Error("flyctl install failed");
  }
  // Add to PATH
  const flyBin = `${process.env.HOME}/.fly/bin`;
  if (!process.env.PATH?.includes(flyBin)) {
    process.env.PATH = `${flyBin}:${process.env.PATH}`;
  }
  if (!getCmd()) {
    logError("flyctl not found in PATH after installation");
    throw new Error("flyctl not in PATH");
  }
  logInfo("flyctl CLI installed");
}

/**
 * Extract a token from fly CLI output.
 * Runs the given command, strips ANSI codes, and finds a line that looks like a token.
 * Token formats: "FlyV1 fm2_...", "fm2_...", "m2...." or a bare alphanumeric string.
 * `fly tokens create` outputs the token prefixed with "FlyV1 " (~650-700 chars).
 */
function extractTokenFromCli(flyCmd: string, args: string[]): string {
  try {
    const proc = Bun.spawnSync(
      [
        flyCmd,
        ...args,
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    // Try stdout first, then stderr
    for (const output of [
      stdout,
      stderr,
    ]) {
      for (const line of output.split("\n")) {
        const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!cleaned) {
          continue;
        }
        // Match "FlyV1 fm2_..." (the standard output format)
        if (/^FlyV1\s+\S+/.test(cleaned)) {
          return cleaned;
        }
        // Match bare macaroon tokens: fm2_..., m2....
        if (/^(fm2_|m2\.)\S+/.test(cleaned)) {
          return cleaned;
        }
        // Skip deprecation notices, help text, error messages
        if (/deprecated|command|usage|error|failed|help|available|flags/i.test(cleaned)) {
          continue;
        }
        if (cleaned.startsWith("-") || cleaned.startsWith("The ") || cleaned.startsWith("Use ")) {
          continue;
        }
        // A long alphanumeric string is likely a token
        if (/^[a-zA-Z0-9_.,+/=: -]{40,}$/.test(cleaned)) {
          return cleaned;
        }
      }
    }
  } catch {
    // ignore
  }
  return "";
}

export async function ensureFlyToken(): Promise<void> {
  const flyCmd = getCmd();

  // 1. Env var
  if (process.env.FLY_API_TOKEN) {
    flyApiToken = sanitizeFlyToken(process.env.FLY_API_TOKEN);
    if (await testFlyToken()) {
      logInfo("Using Fly.io API token from environment");
      await saveTokenToConfig(flyApiToken);
      syncTokenToEnv();
      return;
    }
    logWarn("FLY_API_TOKEN from environment is invalid or expired");
    flyApiToken = "";
  }

  // 2. Saved config
  const saved = loadTokenFromConfig();
  if (saved) {
    flyApiToken = sanitizeFlyToken(saved);
    if (await testFlyToken()) {
      logInfo("Using saved Fly.io API token");
      syncTokenToEnv();
      return;
    }
    logWarn("Saved Fly.io token is invalid or expired");
    flyApiToken = "";
  }

  // 3. Try existing fly CLI session — try multiple token commands
  //    "fly auth token" is deprecated in newer flyctl; "fly tokens create org" is the replacement.
  //    Org tokens are needed (not deploy tokens) since spawn creates new apps.
  if (flyCmd) {
    const tokenCmds: string[][] = [
      [
        "tokens",
        "create",
        "org",
        "--expiry",
        "24h",
      ],
      [
        "auth",
        "token",
      ],
    ];
    for (const args of tokenCmds) {
      const token = extractTokenFromCli(flyCmd, args);
      if (token) {
        flyApiToken = sanitizeFlyToken(token);
        if (await testFlyToken()) {
          logInfo("Using Fly.io API token from fly CLI");
          await saveTokenToConfig(flyApiToken);
          syncTokenToEnv();
          return;
        }
        flyApiToken = "";
      }
    }
    logWarn("No valid token from fly CLI session");
  }

  // 4. OAuth login via fly auth login
  if (flyCmd) {
    logStep("Launching Fly.io OAuth login...");
    const proc = Bun.spawn(
      [
        flyCmd,
        "auth",
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
    await proc.exited;

    // After login, try to get an org token (needed for creating apps)
    const tokenCmds: string[][] = [
      [
        "tokens",
        "create",
        "org",
        "--expiry",
        "24h",
      ],
      [
        "auth",
        "token",
      ],
    ];
    for (const args of tokenCmds) {
      const token = extractTokenFromCli(flyCmd, args);
      if (token) {
        flyApiToken = sanitizeFlyToken(token);
        await saveTokenToConfig(flyApiToken);
        syncTokenToEnv();
        logInfo("Authenticated with Fly.io via OAuth");
        return;
      }
    }
    logWarn("fly auth login did not succeed");
  }

  // 5. Manual token paste
  logStep("Manual token entry (last resort)");
  logWarn("Get a token from: https://fly.io/dashboard -> Tokens");
  logWarn("Or run: fly tokens create org");
  const token = await prompt("Enter your Fly.io API token: ");
  if (!token) {
    throw new Error("No token provided");
  }
  flyApiToken = sanitizeFlyToken(token);
  if (!(await testFlyToken())) {
    logError("Token is invalid");
    flyApiToken = "";
    throw new Error("Invalid Fly.io token");
  }
  await saveTokenToConfig(flyApiToken);
  syncTokenToEnv();
  logInfo("Using manually entered Fly.io API token");
}

// ─── Organization Listing ────────────────────────────────────────────────────

interface OrgEntry {
  slug: string;
  label: string;
}

function parseOrgsJson(json: string): OrgEntry[] {
  const raw = parseJsonRaw(json);
  if (!raw || typeof raw !== "object") {
    return [];
  }

  let orgs: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    orgs = toObjectArray(raw);
  } else {
    // Re-parse as Record<string, unknown> via valibot schema
    const data = parseJson(json);
    if (!data) {
      return [];
    }

    if (data.nodes) {
      orgs = toObjectArray(data.nodes);
    } else if (data.organizations) {
      orgs = toObjectArray(data.organizations);
    } else if (data.data && typeof data.data === "object") {
      const inner = parseJson(JSON.stringify(data.data));
      if (inner?.organizations) {
        const orgData = parseJson(JSON.stringify(inner.organizations));
        if (orgData) {
          orgs = toObjectArray(orgData.nodes);
        }
      }
    } else {
      // {slug: name} format
      return Object.entries(data)
        .filter(([slug]) => slug)
        .map(([slug, name]) => ({
          slug,
          label: String(name),
        }));
    }
  }

  return orgs
    .filter((o) => o.slug || o.name)
    .map((o) => {
      const slug = String(o.slug || o.name || "");
      const name = String(o.name || slug);
      const suffix = o.type ? ` (${o.type})` : "";
      return {
        slug,
        label: `${name}${suffix}`,
      };
    });
}

async function listOrgs(): Promise<OrgEntry[]> {
  const flyCmd = getCmd();

  // 1. Try fly CLI
  if (flyCmd) {
    try {
      const proc = Bun.spawnSync(
        [
          flyCmd,
          "orgs",
          "list",
          "--json",
        ],
        {
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        },
      );
      const json = new TextDecoder().decode(proc.stdout).trim();
      if (json) {
        const orgs = parseOrgsJson(json);
        if (orgs.length > 0) {
          return orgs;
        }
      }
    } catch {
      // fall through
    }
  }

  // 2. Fall back to GraphQL
  if (!flyApiToken) {
    return [];
  }
  const authHeader = flyApiToken.startsWith("FlyV1 ") ? flyApiToken : `Bearer ${flyApiToken}`;

  try {
    const resp = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: '{"query":"{ organizations { nodes { slug name type } } }"}',
      signal: AbortSignal.timeout(15_000),
    });
    const json = await resp.text();
    const orgs = parseOrgsJson(json);
    if (orgs.length > 0) {
      return orgs;
    }
  } catch {
    // fall through
  }

  return [];
}

export async function promptOrg(): Promise<void> {
  if (process.env.FLY_ORG) {
    flyOrg = process.env.FLY_ORG;
    return;
  }
  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    flyOrg = "personal";
    return;
  }

  logStep("Fetching available Fly.io organizations...");
  const orgs = await listOrgs();
  if (orgs.length === 0) {
    logError("Failed to fetch Fly.io organizations");
    logWarn("Debug hints:");
    logWarn("  1. Is fly installed?     Run: fly version");
    logWarn("  2. Is your token valid?  Run: fly auth whoami");
    logWarn("  3. Can you list orgs?    Run: fly orgs list --json");
    throw new Error("Cannot list Fly.io organizations");
  }

  const items = orgs.map((o) => `${o.slug}|${o.label}`);
  flyOrg = await selectFromList(items, "Fly.io organizations", "personal");
  logInfo(`Using Fly.io org: ${flyOrg}`);
}

// ─── Provisioning ────────────────────────────────────────────────────────────

async function createApp(name: string): Promise<void> {
  logStep(`Creating Fly.io app '${name}'...`);
  const body = JSON.stringify({
    app_name: name,
    org_slug: flyOrg || "personal",
  });
  const resp = await flyApi("POST", "/apps", body);
  if (resp.includes('"error"')) {
    const data = parseJson(resp);
    const errMsg = data?.error || "Unknown error";
    if (/already exists/i.test(String(errMsg))) {
      logInfo(`App '${name}' already exists, reusing it`);
      return;
    }
    logError(`Failed to create Fly.io app: ${errMsg}`);
    if (/taken|Name.*valid/i.test(String(errMsg))) {
      logWarn("Fly.io app names are globally unique. Set a different name with: FLY_APP_NAME=my-unique-name");
    }
    throw new Error(`App creation failed: ${errMsg}`);
  }
  logInfo(`App '${name}' created`);
}

async function createMachine(
  name: string,
  region: string,
  cpuKind: CpuKind,
  cpus: number,
  vmMemory: number,
  volumeId?: string,
  image?: string,
): Promise<string> {
  const kindLabel = cpuKind === "performance" ? "dedicated" : "shared";
  logStep(`Creating Fly.io machine (region: ${region}, ${cpus} ${kindLabel} vCPU, ${vmMemory}MB)...`);
  const config: Record<string, unknown> = {
    image: image || "ubuntu:24.04",
    guest: {
      cpu_kind: cpuKind,
      cpus,
      memory_mb: vmMemory,
    },
    init: {
      exec: [
        "/bin/sleep",
        "inf",
      ],
    },
    auto_destroy: false,
  };
  if (volumeId) {
    config.mounts = [
      {
        volume: volumeId,
        path: "/data",
      },
    ];
  }
  const body = JSON.stringify({
    name,
    region,
    config,
  });

  const resp = await flyApi("POST", `/apps/${name}/machines`, body);
  if (resp.includes('"error"')) {
    const data = parseJson(resp);
    logError(`Failed to create Fly.io machine: ${data?.error || "Unknown error"}`);
    logWarn("Check your dashboard: https://fly.io/dashboard");
    throw new Error("Machine creation failed");
  }

  const data = parseJson(resp);
  const machineId = isString(data?.id) ? data.id : undefined;
  if (!machineId) {
    logError("Failed to extract machine ID from API response");
    throw new Error("No machine ID");
  }
  logInfo(`Machine created: ID=${machineId}, App=${name}`);
  return machineId;
}

async function waitForMachineStart(name: string, machineId: string, timeout = 60, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    logStep(`Waiting for machine to start (timeout: ${timeout}s, attempt ${attempt}/${retries})...`);
    const resp = await flyApi("GET", `/apps/${name}/machines/${machineId}/wait?state=started&timeout=${timeout}`);
    if (!hasError(resp)) {
      logInfo("Machine is running");
      return;
    }
    if (attempt < retries) {
      logWarn("Machine not ready yet, retrying...");
      continue;
    }
    const data = parseJson(resp);
    logError(`Machine did not reach 'started' state: ${data?.error || "timeout"}`);
    logError("Try a new region: FLY_REGION=ord spawn fly <agent>");
    throw new Error("Machine start timeout");
  }
}

async function cleanupOnFailure(appName: string): Promise<void> {
  logWarn(`Cleaning up app '${appName}' after provisioning failure...`);
  try {
    await flyApi("DELETE", `/apps/${appName}`, undefined, 1);
  } catch {
    // best-effort cleanup
  }
}

async function createVolume(name: string, region: string, sizeGb: number): Promise<string> {
  logStep(`Creating ${sizeGb}GB volume...`);
  const body = JSON.stringify({
    name: "data",
    region,
    size_gb: sizeGb,
  });
  const resp = await flyApi("POST", `/apps/${name}/volumes`, body);
  const data = parseJson(resp);
  if (!data?.id) {
    logError("Failed to create volume");
    throw new Error("Volume creation failed");
  }
  const volumeId = isString(data.id) ? data.id : String(data.id);
  logInfo(`Volume created: ${volumeId}`);
  return volumeId;
}

export async function listVolumes(appName: string): Promise<
  Array<{
    id: string;
    name: string;
    size_gb: number;
  }>
> {
  const resp = await flyApi("GET", `/apps/${appName}/volumes`);
  const data = parseJsonRaw(resp);
  if (!Array.isArray(data)) {
    return [];
  }
  const items = toObjectArray(data);
  return items
    .filter((item) => item.id)
    .map((item) => ({
      id: String(item.id),
      name: String(item.name || "unnamed"),
      size_gb: isNumber(item.size_gb) ? item.size_gb : 0,
    }));
}

export async function createServer(name: string, opts: ServerOptions, image?: string): Promise<void> {
  const region = process.env.FLY_REGION || "iad";

  if (!validateRegionName(region)) {
    logError("Invalid FLY_REGION");
    throw new Error("Invalid region");
  }

  await createApp(name);

  // Resolve volume: attach existing, create new, or skip
  let volumeId: string | undefined = opts.volumeId;
  if (!volumeId && opts.newVolumeSizeGb) {
    try {
      volumeId = await createVolume(name, region, opts.newVolumeSizeGb);
    } catch (err) {
      await cleanupOnFailure(name);
      throw err;
    }
  }

  let machineId: string;
  try {
    machineId = await createMachine(name, region, opts.cpuKind, opts.cpus, opts.memoryMb, volumeId, image);
  } catch (err) {
    await cleanupOnFailure(name);
    throw err;
  }

  await waitForMachineStart(name, machineId);

  flyMachineId = machineId;
  flyAppName = name;

  saveVmConnection("fly-ssh", "root", machineId, name, "fly");
}

// ─── Execution ───────────────────────────────────────────────────────────────

export async function runServer(cmd: string, timeoutSecs?: number): Promise<void> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const flyCmd = getCmd()!;

  // Wrap command with a background keepalive that sends a space to stderr every
  // 10s. Without this, flyctl tears down silent SSH sessions ("session forcibly
  // closed") when no data flows for too long (e.g. during npm install).
  const wrappedCmd = `(while true; do sleep 10; printf ' ' >&2; done) & _ka=$!; (${fullCmd}); _rc=$?; kill $_ka 2>/dev/null; wait $_ka 2>/dev/null; exit $_rc`;

  const escapedCmd = wrappedCmd.replace(/'/g, "'\\''");
  // Use fly ssh console (WireGuard) instead of fly machine exec (HTTP) to avoid
  // 408 deadline_exceeded on long-running commands.
  const args = [
    flyCmd,
    "ssh",
    "console",
    "-a",
    flyAppName,
    "-C",
    `bash -c '${escapedCmd}'`,
  ];

  // Don't inherit stdin — commands like `claude install` try to read input and
  // hang. Use "pipe" but keep it open until the process exits — closing stdin
  // early causes flyctl to tear down the WireGuard transport ("session forcibly
  // closed") before long-running commands like `bun install` finish.
  const proc = Bun.spawn(args, {
    stdio: [
      "pipe",
      "inherit",
      "inherit",
    ],
    env: process.env,
  });
  // Local safety timer — WireGuard has no HTTP deadline but we still want a ceiling.
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

/** Run a command and capture stdout. */
export async function runServerCapture(cmd: string, timeoutSecs?: number): Promise<string> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const flyCmd = getCmd()!;

  const escapedCmd = fullCmd.replace(/'/g, "'\\''");
  const args = [
    flyCmd,
    "ssh",
    "console",
    "-a",
    flyAppName,
    "-C",
    `bash -c '${escapedCmd}'`,
  ];

  const proc = Bun.spawn(args, {
    stdio: [
      "pipe",
      "pipe",
      "pipe",
    ],
    env: process.env,
  });
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

export async function uploadFile(localPath: string, remotePath: string): Promise<void> {
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath)) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }
  const flyCmd = getCmd()!;
  const content: Buffer = readFileSync(localPath);
  const b64 = content.toString("base64");
  const proc = Bun.spawn(
    [
      flyCmd,
      "ssh",
      "console",
      "-a",
      flyAppName,
      "-C",
      `bash -c 'printf "%s" ${b64} | base64 -d > ${remotePath}'`,
    ],
    {
      stdio: [
        "pipe",
        "ignore",
        "ignore",
      ],
      env: process.env,
    },
  );
  const exitCode = await proc.exited;
  try {
    proc.stdin!.end();
  } catch {
    /* already closed */
  }
  if (exitCode !== 0) {
    throw new Error(`upload_file failed for ${remotePath}`);
  }
}

export async function interactiveSession(cmd: string): Promise<number> {
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  // Single-quote escaping prevents premature shell expansion of $variables in cmd
  // (JSON.stringify double-quoting lets the shell expand $vars before the script runs)
  const shellEscapedCmd = cmd.replace(/'/g, "'\\''");
  const fullCmd = `export TERM=${term} PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c '${shellEscapedCmd}'`;
  // Shell-quote the command for -C
  const escapedCmd = fullCmd.replace(/'/g, "'\\''");
  const flyCmd = getCmd()!;

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      flyCmd,
      [
        "ssh",
        "console",
        "-a",
        flyAppName,
        "--pty",
        "-C",
        `bash -c '${escapedCmd}'`,
      ],
      { stdio: "inherit", env: process.env },
    );
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your service '${flyAppName}' is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${FLY_DASHBOARD_URL}`);
  logWarn("");
  logInfo("To delete from CLI:");
  logInfo("  spawn delete");
  logInfo("To reconnect:");
  logInfo(`  fly ssh console -a ${flyAppName}`);

  return exitCode;
}

// ─── Retry + Wait Helpers ────────────────────────────────────────────────────

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

export async function waitForSsh(maxAttempts = 20): Promise<void> {
  logStep("Waiting for SSH connectivity...");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await runServerCapture("echo ok", 15);
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
  logError(`The machine may need more time. Try: fly ssh console -a ${flyAppName}`);
  throw new Error("SSH wait timeout");
}

export async function waitForCloudInit(tier: CloudInitTier = "full"): Promise<void> {
  await waitForSsh();

  const packages = getPackagesForTier(tier);
  logStep("Installing packages...");
  const setupScript = [
    `echo "==> Setting up workspace volume..."`,
    `if [ -d /data ]; then mkdir -p /data/work && ln -sf /data/work /root/work && echo 'cd /root/work 2>/dev/null' >> ~/.bashrc; fi`,
    `echo "==> Installing base packages..."`,
    "export DEBIAN_FRONTEND=noninteractive",
    `apt-get update -y && apt-get install -y --no-install-recommends ${packages.join(" ")} || true`,
    ...(needsNode(tier)
      ? [
          `echo "==> Installing Node.js 22..."`,
          `${NODE_INSTALL_CMD} || true`,
        ]
      : []),
    ...(needsBun(tier)
      ? [
          `echo "==> Checking bun..."`,
          `if ! command -v bun >/dev/null 2>&1 && [ ! -f "$HOME/.bun/bin/bun" ]; then curl -fsSL https://bun.sh/install | bash || true; fi`,
        ]
      : []),
    `for rc in ~/.bashrc ~/.zshrc; do grep -q '.bun/bin' "$rc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$rc"; done`,
  ].join("\n");

  try {
    await runWithRetry(3, 10, 300, setupScript);
  } catch {
    logWarn("Package install had errors, continuing...");
  }
  logInfo("Base tools installed");
}

// ─── Server Name ─────────────────────────────────────────────────────────────

export async function getServerName(): Promise<string> {
  // Check env var first
  if (process.env.FLY_APP_NAME) {
    const name = process.env.FLY_APP_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid FLY_APP_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using app name from environment: ${name}`);
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
    const answer = await prompt(`Fly machine name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(appName?: string): Promise<void> {
  const name = appName || flyAppName;
  if (!name) {
    logError("destroy_server: no app name provided");
    throw new Error("No app name");
  }

  logStep(`Destroying Fly.io app '${name}'...`);

  const resp = await flyApi("GET", `/apps/${name}/machines`);
  const machines = parseJsonRaw(resp);
  const machineList = toObjectArray(Array.isArray(machines) ? machines : []);
  const ids: string[] = machineList.map((m) => (isString(m.id) ? m.id : "")).filter(Boolean);

  for (const mid of ids) {
    logStep(`Stopping machine ${mid}...`);
    try {
      await flyApi("POST", `/apps/${name}/machines/${mid}/stop`, "{}");
    } catch {
      /* ignore */
    }
    await sleep(2000);
    logStep(`Destroying machine ${mid}...`);
    try {
      await flyApi("DELETE", `/apps/${name}/machines/${mid}?force=true`);
    } catch {
      /* ignore */
    }
  }

  const delResp = await flyApi("DELETE", `/apps/${name}`);
  if (delResp.includes('"error"')) {
    const data = parseJson(delResp);
    logError(`Failed to delete app '${name}': ${data?.error || "Unknown error"}`);
    throw new Error("App deletion failed");
  }
  logInfo(`App '${name}' destroyed`);
}

export async function listServers(): Promise<void> {
  const org = flyOrg || process.env.FLY_ORG || "personal";
  const resp = await flyApi("GET", `/apps?org_slug=${org}`);
  const raw = parseJsonRaw(resp);
  let apps: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    apps = toObjectArray(raw);
  } else {
    const record = parseJson(resp);
    apps = record ? toObjectArray(record.apps) : [];
  }
  if (apps.length === 0) {
    console.log("No apps found");
    return;
  }
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("NAME", 25) + pad("ID", 20) + pad("STATUS", 12) + pad("NETWORK", 20));
  console.log("-".repeat(77));
  for (const a of apps) {
    console.log(
      pad(String(a.name ?? "N/A").slice(0, 24), 25) +
        pad(String(a.id ?? "N/A").slice(0, 19), 20) +
        pad(String(a.status ?? "N/A").slice(0, 11), 12) +
        pad(String(a.network ?? "N/A").slice(0, 19), 20),
    );
  }
}
