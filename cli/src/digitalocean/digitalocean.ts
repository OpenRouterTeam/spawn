// digitalocean/digitalocean.ts — Core DigitalOcean provider: API, auth, SSH, provisioning

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  logInfo,
  logWarn,
  logError,
  logStep,
  prompt,
  openBrowser,
  validateServerName,
  validateRegionName,
  toKebabCase,
  defaultSpawnName,
  sanitizeTermValue,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";

const DO_API_BASE = "https://api.digitalocean.com/v2";
const DO_DASHBOARD_URL = "https://cloud.digitalocean.com/droplets";

// ─── DO OAuth Constants ─────────────────────────────────────────────────────

const DO_OAUTH_AUTHORIZE = "https://cloud.digitalocean.com/v1/oauth/authorize";
const DO_OAUTH_TOKEN = "https://cloud.digitalocean.com/v1/oauth/token";

// OAuth application credentials (embedded, same pattern as gh CLI / doctl).
// Public clients cannot keep secrets confidential — security comes from the
// authorization code flow itself (user consent, localhost redirect, CSRF state).
const DO_CLIENT_ID = "c82b64ac5f9cd4d03b686bebf17546c603b9c368a296a8c4c0718b1f405e4bdc";
const DO_CLIENT_SECRET = "8083ef0317481d802d15b68f1c0b545b726720dbf52d00d17f649cc794efdfd9";

// Fine-grained scopes for spawn (minimum required)
const DO_SCOPES = [
  "account:read",
  "droplet:create",
  "droplet:delete",
  "droplet:read",
  "ssh_key:create",
  "ssh_key:read",
  "regions:read",
  "sizes:read",
  "image:read",
  "actions:read",
].join(" ");

const DO_OAUTH_CALLBACK_PORT = 5190;

// ─── State ───────────────────────────────────────────────────────────────────
let doToken = "";
let doDropletId = "";
let doServerIp = "";

export function getState() {
  return {
    doToken,
    doDropletId,
    doServerIp,
  };
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function doApi(
  method: string,
  endpoint: string,
  body?: string,
  maxRetries = 3,
): Promise<{
  status: number;
  text: string;
}> {
  const url = `${DO_API_BASE}${endpoint}`;

  let interval = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doToken}`,
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
      return {
        status: resp.status,
        text,
      };
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err;
      }
      logWarn(`API request failed (attempt ${attempt}/${maxRetries}), retrying...`);
      await sleep(interval * 1000);
      interval = Math.min(interval * 2, 30);
    }
  }
  throw new Error("doApi: unreachable");
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

// ─── Token Persistence ───────────────────────────────────────────────────────

const DO_CONFIG_PATH = `${process.env.HOME}/.config/spawn/digitalocean.json`;

interface DoConfig {
  api_key?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number;
  auth_method?: "oauth" | "manual";
}

function loadConfig(): DoConfig | null {
  try {
    return JSON.parse(readFileSync(DO_CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

async function saveConfig(config: DoConfig): Promise<void> {
  const dir = DO_CONFIG_PATH.replace(/\/[^/]+$/, "");
  await Bun.spawn([
    "mkdir",
    "-p",
    dir,
  ]).exited;
  await Bun.write(DO_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

async function saveTokenToConfig(token: string, refreshToken?: string, expiresIn?: number): Promise<void> {
  const config: DoConfig = {
    api_key: token,
    token,
  };
  if (refreshToken) {
    config.refresh_token = refreshToken;
    config.auth_method = "oauth";
  }
  if (expiresIn) {
    config.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
  }
  await saveConfig(config);
}

function loadTokenFromConfig(): string | null {
  const data = loadConfig();
  if (!data) {
    return null;
  }
  const token = data.api_key || data.token || "";
  if (!token) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(token)) {
    return null;
  }
  return token;
}

function loadRefreshToken(): string | null {
  const data = loadConfig();
  if (!data?.refresh_token) {
    return null;
  }
  if (!/^[a-zA-Z0-9._/@:+=, -]+$/.test(data.refresh_token)) {
    return null;
  }
  return data.refresh_token;
}

function isTokenExpired(): boolean {
  const data = loadConfig();
  if (!data?.expires_at) {
    return false;
  }
  // Consider expired 5 minutes before actual expiry
  return Math.floor(Date.now() / 1000) >= data.expires_at - 300;
}

// ─── Token Validation ────────────────────────────────────────────────────────

async function testDoToken(): Promise<boolean> {
  if (!doToken) {
    return false;
  }
  try {
    const { text } = await doApi("GET", "/account", undefined, 1);
    return text.includes('"uuid"');
  } catch {
    return false;
  }
}

// ─── DO OAuth Flow ──────────────────────────────────────────────────────────

const OAUTH_CSS =
  "*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;color:#090a0b}@media(prefers-color-scheme:dark){body{background:#090a0b;color:#fafafa}}.card{text-align:center;max-width:400px;padding:2rem}.icon{font-size:2.5rem;margin-bottom:1rem}h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}p{font-size:.875rem;color:#6b7280}@media(prefers-color-scheme:dark){p{color:#9ca3af}}";

const OAUTH_SUCCESS_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>DigitalOcean Authorization Successful</h1><p>You can close this tab and return to your terminal.</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`;

const OAUTH_ERROR_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}h1{color:#dc2626}@media(prefers-color-scheme:dark){h1{color:#ef4444}}</style></head><body><div class="card"><div class="icon">&#10007;</div><h1>Authorization Failed</h1><p>Invalid or missing state parameter (CSRF protection). Please try again.</p></div></body></html>`;

function generateCsrfState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isOAuthConfigured(): boolean {
  return true;
}

async function tryRefreshDoToken(): Promise<string | null> {
  if (!isOAuthConfigured()) {
    return null;
  }

  const refreshToken = loadRefreshToken();
  if (!refreshToken) {
    return null;
  }

  logStep("Attempting to refresh DigitalOcean token...");

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: DO_CLIENT_ID,
      client_secret: DO_CLIENT_SECRET,
    });

    const resp = await fetch(DO_OAUTH_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      logWarn("Token refresh failed — refresh token may be expired");
      return null;
    }

    const data = (await resp.json()) as any;
    if (!data.access_token) {
      logWarn("Token refresh returned no access token");
      return null;
    }

    await saveTokenToConfig(data.access_token, data.refresh_token || refreshToken, data.expires_in);
    logInfo("DigitalOcean token refreshed successfully");
    return data.access_token;
  } catch {
    logWarn("Token refresh request failed");
    return null;
  }
}

async function tryDoOAuth(): Promise<string | null> {
  if (!isOAuthConfigured()) {
    return null;
  }

  logStep("Attempting DigitalOcean OAuth authentication...");

  // Check connectivity to DigitalOcean
  try {
    await fetch("https://cloud.digitalocean.com", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    logWarn("Cannot reach cloud.digitalocean.com — network may be unavailable");
    return null;
  }

  const csrfState = generateCsrfState();
  let oauthCode: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  // Try ports in range
  let actualPort = DO_OAUTH_CALLBACK_PORT;
  for (let p = DO_OAUTH_CALLBACK_PORT; p < DO_OAUTH_CALLBACK_PORT + 10; p++) {
    try {
      server = Bun.serve({
        port: p,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/callback") {
            // Check for error response from DO
            const error = url.searchParams.get("error");
            if (error) {
              const desc = url.searchParams.get("error_description") || error;
              logError(`DigitalOcean authorization denied: ${desc}`);
              return new Response(OAUTH_ERROR_HTML, {
                status: 403,
                headers: {
                  "Content-Type": "text/html",
                  Connection: "close",
                },
              });
            }

            const code = url.searchParams.get("code");
            if (!code) {
              return new Response(OAUTH_ERROR_HTML, {
                status: 400,
                headers: {
                  "Content-Type": "text/html",
                  Connection: "close",
                },
              });
            }

            // CSRF state validation
            if (url.searchParams.get("state") !== csrfState) {
              return new Response(OAUTH_ERROR_HTML, {
                status: 403,
                headers: {
                  "Content-Type": "text/html",
                  Connection: "close",
                },
              });
            }

            // Validate code format (alphanumeric + common delimiters)
            if (!/^[a-zA-Z0-9_-]{8,256}$/.test(code)) {
              return new Response("<html><body><h1>Invalid Authorization Code</h1></body></html>", {
                status: 400,
                headers: {
                  "Content-Type": "text/html",
                },
              });
            }

            oauthCode = code;
            return new Response(OAUTH_SUCCESS_HTML, {
              headers: {
                "Content-Type": "text/html",
                Connection: "close",
              },
            });
          }
          return new Response("Waiting for DigitalOcean OAuth callback...", {
            headers: {
              "Content-Type": "text/html",
            },
          });
        },
      });
      actualPort = p;
      break;
    } catch {}
  }

  if (!server) {
    logWarn(
      `Failed to start OAuth server — ports ${DO_OAUTH_CALLBACK_PORT}-${DO_OAUTH_CALLBACK_PORT + 9} may be in use`,
    );
    return null;
  }

  logInfo(`OAuth server listening on port ${actualPort}`);

  const redirectUri = `http://localhost:${actualPort}/callback`;
  const authParams = new URLSearchParams({
    client_id: DO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DO_SCOPES,
    state: csrfState,
  });
  const authUrl = `${DO_OAUTH_AUTHORIZE}?${authParams.toString()}`;

  logStep("Opening browser to authorize with DigitalOcean...");
  logStep(`If the browser doesn't open, visit: ${authUrl}`);
  openBrowser(authUrl);

  // Wait up to 120 seconds
  logStep("Waiting for authorization in browser (timeout: 120s)...");
  const deadline = Date.now() + 120_000;
  while (!oauthCode && Date.now() < deadline) {
    await sleep(500);
  }

  server.stop(true);

  if (!oauthCode) {
    logError("OAuth authentication timed out after 120 seconds");
    logError("Alternative: Use a manual API token instead");
    logError("  export DO_API_TOKEN=dop_v1_...");
    return null;
  }

  // Exchange code for token
  logStep("Exchanging authorization code for access token...");
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: oauthCode,
      client_id: DO_CLIENT_ID,
      client_secret: DO_CLIENT_SECRET,
      redirect_uri: redirectUri,
    });

    const resp = await fetch(DO_OAUTH_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      logError(`Token exchange failed (HTTP ${resp.status})`);
      logWarn(`Response: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as any;
    if (!data.access_token) {
      logError("Token exchange returned no access token");
      return null;
    }

    await saveTokenToConfig(data.access_token, data.refresh_token, data.expires_in);
    logInfo("Successfully obtained DigitalOcean access token via OAuth!");
    return data.access_token;
  } catch (_err) {
    logError("Failed to exchange authorization code");
    return null;
  }
}

// ─── Authentication ──────────────────────────────────────────────────────────

/** Returns true if browser OAuth was triggered (so caller can delay before next OAuth). */
export async function ensureDoToken(): Promise<boolean> {
  // 1. Env var
  if (process.env.DO_API_TOKEN) {
    doToken = process.env.DO_API_TOKEN.trim();
    if (await testDoToken()) {
      logInfo("Using DigitalOcean API token from environment");
      await saveTokenToConfig(doToken);
      return false;
    }
    logWarn("DO_API_TOKEN from environment is invalid");
    doToken = "";
  }

  // 2. Saved config (check expiry first, try refresh if needed)
  const saved = loadTokenFromConfig();
  if (saved) {
    if (isTokenExpired()) {
      logWarn("Saved DigitalOcean token has expired, trying refresh...");
      const refreshed = await tryRefreshDoToken();
      if (refreshed) {
        doToken = refreshed;
        if (await testDoToken()) {
          logInfo("Using refreshed DigitalOcean token");
          return false;
        }
      }
    } else {
      doToken = saved;
      if (await testDoToken()) {
        logInfo("Using saved DigitalOcean API token");
        return false;
      }
      logWarn("Saved DigitalOcean token is invalid or expired");
      // Try refresh as fallback
      const refreshed = await tryRefreshDoToken();
      if (refreshed) {
        doToken = refreshed;
        if (await testDoToken()) {
          logInfo("Using refreshed DigitalOcean token");
          return false;
        }
      }
    }
    doToken = "";
  }

  // 3. Try OAuth browser flow
  const oauthToken = await tryDoOAuth();
  if (oauthToken) {
    doToken = oauthToken;
    if (await testDoToken()) {
      logInfo("Using DigitalOcean token from OAuth");
      return true;
    }
    logWarn("OAuth token failed validation");
    doToken = "";
  }

  // 4. Manual entry (fallback)
  logStep("DigitalOcean API Token Required");
  logWarn("Get a token from: https://cloud.digitalocean.com/account/api/tokens");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = await prompt("Enter your DigitalOcean API token: ");
    if (!token) {
      logError("Token cannot be empty");
      continue;
    }
    doToken = token.trim();
    if (await testDoToken()) {
      await saveTokenToConfig(doToken);
      logInfo("DigitalOcean API token validated and saved");
      return false;
    }
    logError("Token is invalid");
    doToken = "";
  }

  logError("No valid token after 3 attempts");
  throw new Error("DigitalOcean authentication failed");
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
  } as any);
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
      "-l",
      "-E",
      "md5",
      "-f",
      pubPath,
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
  const match = output.match(/MD5:([a-f0-9:]+)/);
  return match ? match[1] : "";
}

export async function ensureSshKey(): Promise<void> {
  const { pubPath } = generateSshKeyIfMissing();
  const fingerprint = getSshFingerprint(pubPath);
  if (!fingerprint) {
    logWarn("Could not determine SSH key fingerprint");
    return;
  }

  // Check if key is registered with DigitalOcean
  const { text } = await doApi("GET", "/account/keys");
  const data = parseJson(text);
  const keys: any[] = data?.ssh_keys || [];

  const found = keys.some((k: any) => {
    const fp = k.fingerprint || "";
    return fp === fingerprint;
  });

  if (found) {
    logInfo("SSH key already registered with DigitalOcean");
    return;
  }

  // Register key
  logStep("Registering SSH key with DigitalOcean...");
  const pubKey = readFileSync(pubPath, "utf-8").trim();
  const body = JSON.stringify({
    name: "spawn",
    public_key: pubKey,
  });
  const { text: regText } = await doApi("POST", "/account/keys", body);

  if (regText.includes('"id"')) {
    logInfo("SSH key registered with DigitalOcean");
    return;
  }

  // Key may already exist under a different name — non-fatal
  if (regText.includes("already been taken") || regText.includes("already in use")) {
    logInfo("SSH key already registered (under a different name)");
    return;
  }

  logWarn("SSH key registration may have failed, continuing...");
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
    // Connection file may not exist — non-fatal
  }
}

// ─── Provisioning ────────────────────────────────────────────────────────────

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
      "if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.sh/install | bash; fi",
      "ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true",
    );
  }
  lines.push(
    'for rc in ~/.bashrc ~/.zshrc; do grep -q ".bun/bin" "$rc" 2>/dev/null || echo \'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\' >> "$rc"; done',
    "touch /root/.cloud-init-complete",
  );
  return lines.join("\n");
}

export async function createServer(name: string, tier?: CloudInitTier): Promise<void> {
  const size = process.env.DO_DROPLET_SIZE || "s-2vcpu-4gb";
  const region = process.env.DO_REGION || "nyc3";
  const image = "ubuntu-24-04-x64";

  if (!validateRegionName(region)) {
    logError("Invalid DO_REGION");
    throw new Error("Invalid region");
  }

  logStep(`Creating DigitalOcean droplet '${name}' (size: ${size}, region: ${region})...`);

  // Get all SSH key IDs
  const { text: keysText } = await doApi("GET", "/account/keys");
  const keysData = parseJson(keysText);
  const sshKeyIds: number[] = (keysData?.ssh_keys || []).map((k: any) => k.id).filter(Boolean);

  const userdata = getCloudInitUserdata(tier);
  const body = JSON.stringify({
    name,
    region,
    size,
    image,
    ssh_keys: sshKeyIds,
    user_data: userdata,
    backups: false,
    monitoring: false,
  });

  const { text: createText } = await doApi("POST", "/droplets", body);
  const createData = parseJson(createText);

  if (!createData?.droplet?.id) {
    const errMsg = createData?.message || "Unknown error";
    logError(`Failed to create DigitalOcean droplet: ${errMsg}`);
    logWarn("Common issues:");
    logWarn("  - Insufficient account balance or payment method required");
    logWarn("  - Region/size unavailable (try different DO_REGION or DO_DROPLET_SIZE)");
    logWarn("  - Droplet limit reached (check account limits)");
    logWarn(`Check your dashboard: ${DO_DASHBOARD_URL}`);
    throw new Error("Droplet creation failed");
  }

  doDropletId = String(createData.droplet.id);
  logInfo(`Droplet created: ID=${doDropletId}`);

  // Wait for droplet to become active and get IP
  await waitForDropletActive(doDropletId);

  saveVmConnection(doServerIp, "root", doDropletId, name, "digitalocean");
}

async function waitForDropletActive(dropletId: string, maxAttempts = 60): Promise<void> {
  logStep("Waiting for droplet to become active...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text } = await doApi("GET", `/droplets/${dropletId}`);
    const data = parseJson(text);
    const status = data?.droplet?.status;

    if (status === "active") {
      const networks = data?.droplet?.networks?.v4 || [];
      const publicNet = networks.find((n: any) => n.type === "public");
      if (publicNet?.ip_address) {
        doServerIp = publicNet.ip_address;
        logInfo(`Droplet active, IP: ${doServerIp}`);
        return;
      }
    }

    if (attempt >= maxAttempts) {
      logError("Droplet did not become active in time");
      throw new Error("Droplet activation timeout");
    }

    logStep(`Droplet status: ${status || "unknown"} (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
}

// ─── SSH Execution ───────────────────────────────────────────────────────────

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

export async function waitForCloudInit(ip?: string, maxAttempts = 60): Promise<void> {
  const serverIp = ip || doServerIp;
  logStep("Waiting for SSH connectivity...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "ssh",
          ...SSH_OPTS,
          `root@${serverIp}`,
          "echo ok",
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
      if (exitCode === 0 && stdout.includes("ok")) {
        logInfo("SSH is ready");
        break;
      }
    } catch {
      // ignore
    }
    if (attempt >= maxAttempts) {
      logError("SSH connectivity failed");
      throw new Error("SSH wait timeout");
    }
    logStep(`SSH not ready yet (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }

  // Stream cloud-init output so the user sees progress in real time
  logStep("Streaming cloud-init output (timeout: 5min)...");
  const remoteScript =
    "tail -f /var/log/cloud-init-output.log 2>/dev/null & TAIL_PID=$!\n" +
    "for i in $(seq 1 150); do\n" +
    "  if [ -f /root/.cloud-init-complete ]; then\n" +
    "    kill $TAIL_PID 2>/dev/null; wait $TAIL_PID 2>/dev/null\n" +
    '    echo ""; echo "--- cloud-init complete ---"; exit 0\n' +
    "  fi\n" +
    "  sleep 2\n" +
    "done\n" +
    "kill $TAIL_PID 2>/dev/null; wait $TAIL_PID 2>/dev/null\n" +
    'echo ""; echo "--- cloud-init timed out ---"; exit 1';

  try {
    const proc = Bun.spawn(
      [
        "ssh",
        ...SSH_OPTS,
        `root@${serverIp}`,
        remoteScript,
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
    if (exitCode === 0) {
      logInfo("Cloud-init complete");
      return;
    }
    logWarn("Cloud-init did not complete within 5 minutes");
  } catch {
    logWarn("Could not stream cloud-init log, falling back to polling...");
  }

  // Fallback poll if streaming failed (e.g. log file not yet created)
  for (let attempt = 1; attempt <= 20; attempt++) {
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
      if ((await proc.exited) === 0 && stdout.includes("done")) {
        logInfo("Cloud-init complete");
        return;
      }
    } catch {
      /* ignore */
    }
    logStep(`Cloud-init in progress (${attempt}/20)`);
    await sleep(5000);
  }
  logWarn("Cloud-init marker not found, continuing anyway...");
}

export async function runServer(cmd: string, timeoutSecs?: number, ip?: string): Promise<void> {
  const serverIp = ip || doServerIp;
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
  const serverIp = ip || doServerIp;
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
  const serverIp = ip || doServerIp;
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
  const serverIp = ip || doServerIp;
  const term = sanitizeTermValue(process.env.TERM || "xterm-256color");
  const fullCmd = `export TERM=${term} PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" && exec bash -l -c ${JSON.stringify(cmd)}`;

  const proc = Bun.spawn(
    [
      "ssh",
      ...SSH_OPTS,
      "-t",
      `root@${serverIp}`,
      fullCmd,
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

  // Post-session summary
  process.stderr.write("\n");
  logWarn(`Session ended. Your DigitalOcean droplet (ID: ${doDropletId}) is still running.`);
  logWarn("Remember to delete it when you're done to avoid ongoing charges.");
  logWarn("");
  logWarn("Manage or delete it in your dashboard:");
  logWarn(`  ${DO_DASHBOARD_URL}`);
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
  if (process.env.DO_DROPLET_NAME) {
    const name = process.env.DO_DROPLET_NAME;
    if (!validateServerName(name)) {
      logError(`Invalid DO_DROPLET_NAME: '${name}'`);
      throw new Error("Invalid server name");
    }
    logInfo(`Using droplet name from environment: ${name}`);
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
    const answer = await prompt(`DigitalOcean droplet name [${fallback}]: `);
    kebab = toKebabCase(answer || fallback) || defaultSpawnName();
  }

  process.env.SPAWN_NAME_DISPLAY = kebab;
  process.env.SPAWN_NAME_KEBAB = kebab;
  logInfo(`Using resource name: ${kebab}`);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export async function destroyServer(dropletId?: string): Promise<void> {
  const id = dropletId || doDropletId;
  if (!id) {
    logError("destroy_server: no droplet ID provided");
    throw new Error("No droplet ID");
  }

  logStep(`Destroying DigitalOcean droplet ${id}...`);
  const { status, text } = await doApi("DELETE", `/droplets/${id}`);

  // DELETE returns 204 No Content on success (empty body)
  if (status === 204) {
    logInfo(`Droplet ${id} destroyed`);
    return;
  }

  const data = parseJson(text);
  if (data?.message) {
    logError(`Failed to destroy droplet ${id}: ${data.message}`);
    logWarn("The droplet may still be running and incurring charges.");
    logWarn(`Delete it manually at: ${DO_DASHBOARD_URL}`);
    throw new Error("Droplet deletion failed");
  }

  logInfo(`Droplet ${id} destroyed`);
}

export async function listServers(): Promise<void> {
  const { text } = await doApi("GET", "/droplets");
  const data = parseJson(text);
  const droplets: any[] = data?.droplets || [];

  if (droplets.length === 0) {
    console.log("No droplets found");
    return;
  }

  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log(pad("NAME", 25) + pad("ID", 12) + pad("STATUS", 12) + pad("IP", 16) + pad("SIZE", 15));
  console.log("-".repeat(80));
  for (const d of droplets) {
    const ip = (d.networks?.v4 || []).find((n: any) => n.type === "public")?.ip_address || "N/A";
    console.log(
      pad((d.name ?? "N/A").slice(0, 24), 25) +
        pad(String(d.id ?? "N/A").slice(0, 11), 12) +
        pad((d.status ?? "N/A").slice(0, 11), 12) +
        pad(ip.slice(0, 15), 16) +
        pad((d.size_slug ?? "N/A").slice(0, 14), 15),
    );
  }
}
