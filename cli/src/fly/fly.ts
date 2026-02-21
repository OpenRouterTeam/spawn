// fly/lib/fly.ts — Core Fly.io provider: API, auth, orgs, provisioning, execution

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
} from "./ui";

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_DASHBOARD_URL = "https://fly.io/dashboard";

// ─── State ───────────────────────────────────────────────────────────────────
let flyApiToken = "";
let flyOrg = "";
let flyMachineId = "";
let flyAppName = "";

export function getState() {
  return { flyApiToken, flyOrg, flyMachineId, flyAppName };
}

export function setOrg(org: string) {
  flyOrg = org;
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function flyApi(
  method: string,
  endpoint: string,
  body?: string,
  maxRetries = 3,
): Promise<string> {
  const url = `${FLY_API_BASE}${endpoint}`;
  const authHeader =
    flyApiToken.startsWith("FlyV1 ")
      ? flyApiToken
      : `Bearer ${flyApiToken}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: authHeader,
      };
      const opts: RequestInit = { method, headers };
      if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
        opts.body = body;
      }
      const resp = await fetch(url, opts);
      const text = await resp.text();

      // Retry on 429 / 5xx
      if ((resp.status === 429 || resp.status >= 500) && attempt < maxRetries) {
        logWarn(
          `API ${resp.status} (attempt ${attempt}/${maxRetries}), retrying in ${interval}s...`,
        );
        await sleep(interval * 1000);
        interval = Math.min(interval * 2, 30);
        continue;
      }
      return text;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
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

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hasError(text: string): boolean {
  return text.includes('"error"') || text.includes('"errors"');
}

function getCmd(): string | null {
  for (const name of ["fly", "flyctl"]) {
    if (Bun.spawnSync(["which", name], { stdio: ["ignore", "pipe", "ignore"] }).exitCode === 0) {
      return name;
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
    if (m) t = "FlyV1 " + m[1];
  } else if (t.startsWith("m2.")) {
    t = "FlyV1 " + t;
  }
  return t;
}

// ─── Token Validation ────────────────────────────────────────────────────────

async function testFlyToken(): Promise<boolean> {
  if (!flyApiToken) return false;
  try {
    const org = flyOrg || "personal";
    const resp = await flyApi("GET", `/apps?org_slug=${org}`, undefined, 1);
    if (!hasError(resp)) return true;
  } catch {
    // fall through
  }
  // Fallback: user API (OAuth/personal tokens)
  try {
    const authHeader = flyApiToken.startsWith("FlyV1 ")
      ? flyApiToken
      : `Bearer ${flyApiToken}`;
    const resp = await fetch("https://api.fly.io/v1/user", {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text && !hasError(text)) return true;
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
  await Bun.spawn(["mkdir", "-p", dir]).exited;
  const escaped = jsonEscape(token);
  await Bun.write(
    FLY_CONFIG_PATH,
    `{\n  "api_key": ${escaped},\n  "token": ${escaped}\n}\n`,
    { mode: 0o600 },
  );
}

function loadTokenFromConfig(): string | null {
  try {
    const data = JSON.parse(
      require("fs").readFileSync(FLY_CONFIG_PATH, "utf-8"),
    );
    const token = data.api_key || data.token || "";
    if (!token) return null;
    // Security: validate token chars
    if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

// ─── Connection Tracking ─────────────────────────────────────────────────────

export function saveVmConnection(
  ip: string,
  user: string,
  serverId: string,
  serverName: string,
  cloud: string,
): void {
  const dir = `${process.env.HOME}/.spawn`;
  const fs = require("fs");
  fs.mkdirSync(dir, { recursive: true });
  const json: Record<string, string> = { ip, user };
  if (serverId) json.server_id = serverId;
  if (serverName) json.server_name = serverName;
  if (cloud) json.cloud = cloud;
  fs.writeFileSync(`${dir}/last-connection.json`, JSON.stringify(json) + "\n");
}

// ─── Authentication ──────────────────────────────────────────────────────────

export async function ensureFlyCli(): Promise<void> {
  if (getCmd()) {
    logInfo("flyctl CLI available");
    return;
  }
  logStep("Installing flyctl CLI...");
  const proc = Bun.spawn(["sh", "-c", "curl -L https://fly.io/install.sh | sh"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
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
    const proc = Bun.spawnSync([flyCmd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    // Try stdout first, then stderr
    for (const output of [stdout, stderr]) {
      for (const line of output.split("\n")) {
        const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!cleaned) continue;
        // Match "FlyV1 fm2_..." (the standard output format)
        if (/^FlyV1\s+\S+/.test(cleaned)) return cleaned;
        // Match bare macaroon tokens: fm2_..., m2....
        if (/^(fm2_|m2\.)\S+/.test(cleaned)) return cleaned;
        // Skip deprecation notices, help text, error messages
        if (/deprecated|command|usage|error|failed|help|available|flags/i.test(cleaned)) continue;
        if (cleaned.startsWith("-") || cleaned.startsWith("The ") || cleaned.startsWith("Use ")) continue;
        // A long alphanumeric string is likely a token
        if (/^[a-zA-Z0-9_.,+/=: -]{40,}$/.test(cleaned)) return cleaned;
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
      ["tokens", "create", "org", "--expiry", "24h"],
      ["auth", "token"],
    ];
    for (const args of tokenCmds) {
      const token = extractTokenFromCli(flyCmd, args);
      if (token) {
        flyApiToken = sanitizeFlyToken(token);
        if (await testFlyToken()) {
          logInfo("Using Fly.io API token from fly CLI");
          await saveTokenToConfig(flyApiToken);
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
    const proc = Bun.spawn([flyCmd, "auth", "login"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;

    // After login, try to get an org token (needed for creating apps)
    const tokenCmds: string[][] = [
      ["tokens", "create", "org", "--expiry", "24h"],
      ["auth", "token"],
    ];
    for (const args of tokenCmds) {
      const token = extractTokenFromCli(flyCmd, args);
      if (token) {
        flyApiToken = sanitizeFlyToken(token);
        await saveTokenToConfig(flyApiToken);
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
  if (!token) throw new Error("No token provided");
  flyApiToken = sanitizeFlyToken(token);
  if (!(await testFlyToken())) {
    logError("Token is invalid");
    flyApiToken = "";
    throw new Error("Invalid Fly.io token");
  }
  await saveTokenToConfig(flyApiToken);
  logInfo("Using manually entered Fly.io API token");
}

// ─── Organization Listing ────────────────────────────────────────────────────

interface OrgEntry {
  slug: string;
  label: string;
}

function parseOrgsJson(json: string): OrgEntry[] {
  const data = parseJson(json);
  if (!data) return [];

  // Handle different org response formats
  let orgs: any[] = [];
  if (Array.isArray(data)) {
    orgs = data;
  } else if (data.nodes) {
    orgs = data.nodes;
  } else if (data.organizations) {
    orgs = data.organizations;
  } else if (data.data?.organizations?.nodes) {
    orgs = data.data.organizations.nodes;
  } else if (typeof data === "object" && !Array.isArray(data)) {
    // {slug: name} format
    return Object.entries(data)
      .filter(([slug]) => slug)
      .map(([slug, name]) => ({ slug, label: String(name) }));
  }

  return orgs
    .filter((o: any) => o.slug || o.name)
    .map((o: any) => {
      const slug = o.slug || o.name || "";
      const name = o.name || slug;
      const suffix = o.type ? ` (${o.type})` : "";
      return { slug, label: `${name}${suffix}` };
    });
}

async function listOrgs(): Promise<OrgEntry[]> {
  const flyCmd = getCmd();

  // 1. Try fly CLI
  if (flyCmd) {
    try {
      const proc = Bun.spawnSync([flyCmd, "orgs", "list", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const json = new TextDecoder().decode(proc.stdout).trim();
      if (json) {
        const orgs = parseOrgsJson(json);
        if (orgs.length > 0) return orgs;
      }
    } catch {
      // fall through
    }
  }

  // 2. Fall back to GraphQL
  if (!flyApiToken) return [];
  const authHeader = flyApiToken.startsWith("FlyV1 ")
    ? flyApiToken
    : `Bearer ${flyApiToken}`;

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
    if (orgs.length > 0) return orgs;
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
    if (/already exists/i.test(errMsg)) {
      logInfo(`App '${name}' already exists, reusing it`);
      return;
    }
    logError(`Failed to create Fly.io app: ${errMsg}`);
    if (/taken|Name.*valid/i.test(errMsg)) {
      logWarn(
        "Fly.io app names are globally unique. Set a different name with: FLY_APP_NAME=my-unique-name",
      );
    }
    throw new Error(`App creation failed: ${errMsg}`);
  }
  logInfo(`App '${name}' created`);
}

async function createMachine(
  name: string,
  region: string,
  vmMemory: number,
): Promise<string> {
  logStep(`Creating Fly.io machine (region: ${region}, memory: ${vmMemory}MB)...`);
  const body = JSON.stringify({
    name,
    region,
    config: {
      image: "ubuntu:24.04",
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: vmMemory },
      init: { exec: ["/bin/sleep", "inf"] },
      auto_destroy: false,
    },
  });

  const resp = await flyApi("POST", `/apps/${name}/machines`, body);
  if (resp.includes('"error"')) {
    const data = parseJson(resp);
    logError(
      `Failed to create Fly.io machine: ${data?.error || "Unknown error"}`,
    );
    logWarn("Check your dashboard: https://fly.io/dashboard");
    throw new Error("Machine creation failed");
  }

  const data = parseJson(resp);
  const machineId = data?.id;
  if (!machineId) {
    logError("Failed to extract machine ID from API response");
    throw new Error("No machine ID");
  }
  logInfo(`Machine created: ID=${machineId}, App=${name}`);
  return machineId;
}

async function waitForMachineStart(
  name: string,
  machineId: string,
  timeout = 60,
  retries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    logStep(
      `Waiting for machine to start (timeout: ${timeout}s, attempt ${attempt}/${retries})...`,
    );
    const resp = await flyApi(
      "GET",
      `/apps/${name}/machines/${machineId}/wait?state=started&timeout=${timeout}`,
    );
    if (!hasError(resp)) {
      logInfo("Machine is running");
      return;
    }
    if (attempt < retries) {
      logWarn(`Machine not ready yet, retrying...`);
      continue;
    }
    const data = parseJson(resp);
    logError(
      `Machine did not reach 'started' state: ${data?.error || "timeout"}`,
    );
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

export async function createServer(name: string): Promise<void> {
  const region = process.env.FLY_REGION || "iad";
  const vmMemory = parseInt(process.env.FLY_VM_MEMORY || "1024", 10);

  if (!validateRegionName(region)) {
    logError("Invalid FLY_REGION");
    throw new Error("Invalid region");
  }
  if (isNaN(vmMemory)) {
    logError("Invalid FLY_VM_MEMORY: must be numeric");
    throw new Error("Invalid VM memory");
  }

  await createApp(name);

  let machineId: string;
  try {
    machineId = await createMachine(name, region, vmMemory);
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

export async function runServer(
  cmd: string,
  timeoutSecs?: number,
): Promise<void> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const flyCmd = getCmd()!;

  const args = [flyCmd, "machine", "exec", flyMachineId, "--app", flyAppName, "--", "bash", "-c", fullCmd];

  if (timeoutSecs) {
    // Look for timeout/gtimeout
    const timeoutBin = Bun.spawnSync(["which", "timeout"], { stdio: ["ignore", "pipe", "ignore"] }).exitCode === 0
      ? "timeout"
      : Bun.spawnSync(["which", "gtimeout"], { stdio: ["ignore", "pipe", "ignore"] }).exitCode === 0
        ? "gtimeout"
        : null;

    if (timeoutBin) {
      args.unshift(timeoutBin, String(timeoutSecs));
    }
  }

  const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`run_server failed (exit ${exitCode}): ${cmd}`);
  }
}

/** Run a command and capture stdout. */
export async function runServerCapture(
  cmd: string,
  timeoutSecs?: number,
): Promise<string> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  const flyCmd = getCmd()!;

  const args = [flyCmd, "machine", "exec", flyMachineId, "--app", flyAppName, "--", "bash", "-c", fullCmd];

  const proc = Bun.spawn(args, { stdio: ["ignore", "pipe", "pipe"] });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutSecs) {
    timer = setTimeout(() => proc.kill(), timeoutSecs * 1000);
  }

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  if (exitCode !== 0) throw new Error(`run_server_capture failed (exit ${exitCode})`);
  return stdout.trim();
}

export async function uploadFile(
  localPath: string,
  remotePath: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9/_.~-]+$/.test(remotePath)) {
    logError(`Invalid remote path: ${remotePath}`);
    throw new Error("Invalid remote path");
  }
  const flyCmd = getCmd()!;
  const fs = require("fs");
  const content = fs.readFileSync(localPath);
  const proc = Bun.spawn(
    [flyCmd, "machine", "exec", flyMachineId, "--app", flyAppName, "--", "bash", "-c", `cat > ${remotePath}`],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  proc.stdin!.write(content);
  proc.stdin!.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`upload_file failed for ${remotePath}`);
}

export async function interactiveSession(cmd: string): Promise<number> {
  const fullCmd = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && ${cmd}`;
  // Shell-quote the command for -C
  const escapedCmd = fullCmd.replace(/'/g, "'\\''");
  const flyCmd = getCmd()!;

  const proc = Bun.spawn(
    [flyCmd, "ssh", "console", "-a", flyAppName, "--pty", "-C", `bash -c '${escapedCmd}'`],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const exitCode = await proc.exited;

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
      if (attempt < maxAttempts) await sleep(sleepSec * 1000);
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

export async function waitForCloudInit(): Promise<void> {
  await waitForSsh();

  logStep("Installing packages...");
  try {
    await runWithRetry(3, 10, 300, "apt-get update -y && apt-get install -y curl unzip git");
  } catch {
    logWarn("Package install failed, continuing anyway...");
  }

  logStep("Installing Node.js...");
  try {
    await runWithRetry(
      3,
      10,
      180,
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
    );
  } catch {
    // ignore
  }

  // Verify node
  try {
    await runServerCapture("which node && node --version", 15);
    const ver = await runServerCapture("node --version", 10);
    logInfo(`Node.js installed: ${ver}`);
  } catch {
    logWarn("Node.js not found after nodesource install, falling back to default Debian package...");
    try {
      await runWithRetry(2, 5, 120, "apt-get install -y nodejs");
      const ver = await runServerCapture("node --version", 10);
      logInfo(`Node.js installed from default Debian repos: ${ver}`);
    } catch {
      logError("Node.js is NOT installed — npm-based agents will not work");
    }
  }

  logStep("Installing bun...");
  try {
    await runWithRetry(2, 5, 120, "curl -fsSL https://bun.sh/install | bash");
  } catch {
    // ignore
  }

  // Add to PATH in shell configs
  const pathLine = 'echo "export PATH=\\"\\$HOME/.local/bin:\\$HOME/.bun/bin:\\$PATH\\"" >> ~/.bashrc';
  const pathLineZsh = 'echo "export PATH=\\"\\$HOME/.local/bin:\\$HOME/.bun/bin:\\$PATH\\"" >> ~/.zshrc';
  try {
    await runServer(pathLine, 30);
  } catch { /* ignore */ }
  try {
    await runServer(pathLineZsh, 30);
  } catch { /* ignore */ }
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

  // Derive from spawn name
  const kebab = process.env.SPAWN_NAME_KEBAB
    || (process.env.SPAWN_NAME ? toKebabCase(process.env.SPAWN_NAME) : "");
  const defaultName = kebab || "spawn";

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return defaultName;
  }

  const answer = await prompt(`Enter app name [${defaultName}]: `);
  const name = answer || defaultName;

  if (!validateServerName(name)) {
    logError(`Invalid app name: '${name}'`);
    throw new Error("Invalid server name");
  }
  return name;
}

/** Prompt for a spawn display name, derive kebab-case resource name. */
export async function promptSpawnName(): Promise<void> {
  if (process.env.SPAWN_NAME_KEBAB) return;

  let displayName: string;
  if (process.env.SPAWN_NAME) {
    displayName = process.env.SPAWN_NAME;
    logInfo(`Spawn name: ${displayName}`);
  } else if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    displayName = "spawn";
  } else {
    process.stderr.write("\n");
    displayName = await prompt('Spawn name (e.g. "My Dev Box"): ');
    if (!displayName) displayName = "spawn";
  }

  let kebab = toKebabCase(displayName) || "spawn";

  if (process.env.SPAWN_NON_INTERACTIVE !== "1") {
    const confirmed = await prompt(`Resource name [${kebab}]: `);
    if (confirmed) {
      kebab = toKebabCase(confirmed) || "spawn";
    }
  }

  process.env.SPAWN_NAME_DISPLAY = displayName;
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
  const machines = parseJson(resp);
  const ids: string[] = (Array.isArray(machines) ? machines : []).map((m: any) => m.id).filter(Boolean);

  for (const mid of ids) {
    logStep(`Stopping machine ${mid}...`);
    try {
      await flyApi("POST", `/apps/${name}/machines/${mid}/stop`, "{}");
    } catch { /* ignore */ }
    await sleep(2000);
    logStep(`Destroying machine ${mid}...`);
    try {
      await flyApi("DELETE", `/apps/${name}/machines/${mid}?force=true`);
    } catch { /* ignore */ }
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
  const data = parseJson(resp);
  const apps: any[] = Array.isArray(data) ? data : data?.apps ?? [];
  if (apps.length === 0) {
    console.log("No apps found");
    return;
  }
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(
    pad("NAME", 25) + pad("ID", 20) + pad("STATUS", 12) + pad("NETWORK", 20),
  );
  console.log("-".repeat(77));
  for (const a of apps) {
    console.log(
      pad((a.name ?? "N/A").slice(0, 24), 25) +
        pad((a.id ?? "N/A").slice(0, 19), 20) +
        pad((a.status ?? "N/A").slice(0, 11), 12) +
        pad((a.network ?? "N/A").slice(0, 19), 20),
    );
  }
}
