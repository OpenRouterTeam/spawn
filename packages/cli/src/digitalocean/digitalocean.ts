// digitalocean/digitalocean.ts — Core DigitalOcean provider: API, auth, SSH, provisioning

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  selectFromList,
} from "../shared/ui";
import type { CloudInitTier } from "../shared/agents";
import { getPackagesForTier, needsNode, needsBun, NODE_INSTALL_CMD } from "../shared/cloud-init";
import { parseJsonObj, isString, isNumber, toObjectArray } from "@openrouter/spawn-shared";
import {
  SSH_BASE_OPTS,
  SSH_INTERACTIVE_OPTS,
  sleep,
  waitForSsh as sharedWaitForSsh,
  killWithTimeout,
  spawnInteractive,
} from "../shared/ssh";
import { ensureSshKeys, getSshFingerprint, getSshKeyOpts } from "../shared/ssh-keys";
import { saveVmConnection } from "../history.js";

const DO_API_BASE = "https://api.digitalocean.com/v2";
const DO_DASHBOARD_URL = "https://cloud.digitalocean.com/droplets";

// ─── DO OAuth Constants ─────────────────────────────────────────────────────

const DO_OAUTH_AUTHORIZE = "https://cloud.digitalocean.com/v1/oauth/authorize";
const DO_OAUTH_TOKEN = "https://cloud.digitalocean.com/v1/oauth/token";

// OAuth application credentials — embedded in the binary, same pattern as gh CLI and doctl.
//
// Why the client_secret is here and why that's acceptable:
//   1. DigitalOcean's token exchange endpoint REQUIRES client_secret — their OAuth
//      implementation does not support PKCE-only public client flows (as of 2026).
//   2. Open-source CLI tools are "public clients" (RFC 6749 §2.1) — any secret
//      shipped in source code or a binary is extractable and provides zero
//      confidentiality. This is a well-understood OAuth limitation.
//   3. Security relies on the authorization code flow itself: user consent in the
//      browser, localhost-only redirect URI, and CSRF state parameter validation.
//   4. The secret alone cannot access user resources — it only allows exchanging a
//      one-time authorization code (which requires user approval) for a token.
//   5. This is the same pattern used by: gh CLI (GitHub), doctl (DigitalOcean),
//      gcloud (Google), and az (Azure).
//
// If DigitalOcean adds PKCE support in the future, the client_secret should be
// removed and replaced with code_challenge/code_verifier parameters.
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

// ─── Token Persistence ───────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(process.env.HOME || homedir(), ".config", "spawn", "digitalocean.json");
}

interface DoConfig {
  api_key?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number;
  auth_method?: "oauth" | "manual";
}

function loadConfig(): DoConfig | null {
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf-8"));
  } catch {
    return null;
  }
}

async function saveConfig(config: DoConfig): Promise<void> {
  const configPath = getConfigPath();
  const dir = configPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, {
    recursive: true,
    mode: 0o700,
  });
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n", {
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

    const data = parseJsonObj(await resp.text());
    if (!data?.access_token) {
      logWarn("Token refresh returned no access token");
      return null;
    }

    const accessToken = isString(data.access_token) ? data.access_token : "";
    const newRefreshToken = isString(data.refresh_token) ? data.refresh_token : undefined;
    const expiresIn = isNumber(data.expires_in) ? data.expires_in : undefined;
    await saveTokenToConfig(accessToken, newRefreshToken || refreshToken, expiresIn);
    logInfo("DigitalOcean token refreshed successfully");
    return accessToken;
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

    const data = parseJsonObj(await resp.text());
    if (!data?.access_token) {
      logError("Token exchange returned no access token");
      return null;
    }

    const accessToken = isString(data.access_token) ? data.access_token : "";
    const oauthRefreshToken = isString(data.refresh_token) ? data.refresh_token : undefined;
    const expiresIn = isNumber(data.expires_in) ? data.expires_in : undefined;
    await saveTokenToConfig(accessToken, oauthRefreshToken, expiresIn);
    logInfo("Successfully obtained DigitalOcean access token via OAuth!");
    return accessToken;
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

export async function ensureSshKey(): Promise<void> {
  const selectedKeys = await ensureSshKeys();

  for (const key of selectedKeys) {
    const fingerprint = getSshFingerprint(key.pubPath);
    if (!fingerprint) {
      logWarn(`Could not determine fingerprint for SSH key '${key.name}'`);
      continue;
    }

    // Check if key is registered with DigitalOcean
    const { text } = await doApi("GET", "/account/keys");
    const data = parseJsonObj(text);
    const keys = toObjectArray(data?.ssh_keys);

    const found = keys.some((k: Record<string, unknown>) => {
      const fp = k.fingerprint || "";
      return fp === fingerprint;
    });

    if (found) {
      logInfo(`SSH key '${key.name}' already registered with DigitalOcean`);
      continue;
    }

    // Register key
    logStep(`Registering SSH key '${key.name}' with DigitalOcean...`);
    const pubKey = readFileSync(key.pubPath, "utf-8").trim();
    const body = JSON.stringify({
      name: `spawn-${key.name}`,
      public_key: pubKey,
    });
    const { text: regText } = await doApi("POST", "/account/keys", body);

    if (regText.includes('"id"')) {
      logInfo(`SSH key '${key.name}' registered with DigitalOcean`);
      continue;
    }

    // Key may already exist under a different name — non-fatal
    if (regText.includes("already been taken") || regText.includes("already in use")) {
      logInfo(`SSH key '${key.name}' already registered (under a different name)`);
      continue;
    }

    logWarn(`SSH key '${key.name}' registration may have failed, continuing...`);
  }
}

// ─── Droplet Size Options ────────────────────────────────────────────────────

export interface DropletSize {
  id: string;
  label: string;
}

export const DROPLET_SIZES: DropletSize[] = [
  {
    id: "s-1vcpu-1gb",
    label: "1 vCPU \u00b7 1 GB RAM \u00b7 $6/mo",
  },
  {
    id: "s-1vcpu-2gb",
    label: "1 vCPU \u00b7 2 GB RAM \u00b7 $12/mo",
  },
  {
    id: "s-2vcpu-2gb",
    label: "2 vCPU \u00b7 2 GB RAM \u00b7 $18/mo",
  },
  {
    id: "s-2vcpu-4gb",
    label: "2 vCPU \u00b7 4 GB RAM \u00b7 $24/mo",
  },
  {
    id: "s-4vcpu-8gb",
    label: "4 vCPU \u00b7 8 GB RAM \u00b7 $48/mo",
  },
  {
    id: "s-8vcpu-16gb",
    label: "8 vCPU \u00b7 16 GB RAM \u00b7 $96/mo",
  },
];

export const DEFAULT_DROPLET_SIZE = "s-2vcpu-4gb";

// ─── Region Options ──────────────────────────────────────────────────────────

export interface DoRegion {
  id: string;
  label: string;
}

export const DO_REGIONS: DoRegion[] = [
  {
    id: "nyc1",
    label: "New York 1",
  },
  {
    id: "nyc3",
    label: "New York 3",
  },
  {
    id: "sfo3",
    label: "San Francisco 3",
  },
  {
    id: "ams3",
    label: "Amsterdam 3",
  },
  {
    id: "sgp1",
    label: "Singapore 1",
  },
  {
    id: "lon1",
    label: "London 1",
  },
  {
    id: "fra1",
    label: "Frankfurt 1",
  },
  {
    id: "tor1",
    label: "Toronto 1",
  },
  {
    id: "blr1",
    label: "Bangalore 1",
  },
  {
    id: "syd1",
    label: "Sydney 1",
  },
];

export const DEFAULT_DO_REGION = "nyc3";

// ─── Interactive Pickers ─────────────────────────────────────────────────────

export async function promptDropletSize(): Promise<string> {
  if (process.env.DO_DROPLET_SIZE) {
    logInfo(`Using droplet size from environment: ${process.env.DO_DROPLET_SIZE}`);
    return process.env.DO_DROPLET_SIZE;
  }

  if (process.env.SPAWN_CUSTOM !== "1") {
    return DEFAULT_DROPLET_SIZE;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_DROPLET_SIZE;
  }

  process.stderr.write("\n");
  const items = DROPLET_SIZES.map((s) => `${s.id}|${s.label}`);
  return selectFromList(items, "DigitalOcean droplet size", DEFAULT_DROPLET_SIZE);
}

export async function promptDoRegion(): Promise<string> {
  if (process.env.DO_REGION) {
    logInfo(`Using region from environment: ${process.env.DO_REGION}`);
    return process.env.DO_REGION;
  }

  if (process.env.SPAWN_CUSTOM !== "1") {
    return DEFAULT_DO_REGION;
  }

  if (process.env.SPAWN_NON_INTERACTIVE === "1") {
    return DEFAULT_DO_REGION;
  }

  process.stderr.write("\n");
  const items = DO_REGIONS.map((r) => `${r.id}|${r.label}`);
  return selectFromList(items, "DigitalOcean region", DEFAULT_DO_REGION);
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

export async function createServer(
  name: string,
  tier?: CloudInitTier,
  dropletSize?: string,
  region?: string,
): Promise<void> {
  const size = dropletSize || process.env.DO_DROPLET_SIZE || "s-2vcpu-4gb";
  const effectiveRegion = region || process.env.DO_REGION || "nyc3";
  const image = "ubuntu-24-04-x64";

  if (!validateRegionName(effectiveRegion)) {
    logError("Invalid DO_REGION");
    throw new Error("Invalid region");
  }

  logStep(`Creating DigitalOcean droplet '${name}' (size: ${size}, region: ${effectiveRegion})...`);

  // Get all SSH key IDs
  const { text: keysText } = await doApi("GET", "/account/keys");
  const keysData = parseJsonObj(keysText);
  const sshKeyIds: number[] = toObjectArray(keysData?.ssh_keys)
    .map((k) => (isNumber(k.id) ? k.id : 0))
    .filter((n) => n > 0);

  const userdata = getCloudInitUserdata(tier);
  const body = JSON.stringify({
    name,
    region: effectiveRegion,
    size,
    image,
    ssh_keys: sshKeyIds,
    user_data: userdata,
    backups: false,
    monitoring: false,
  });

  const { text: createText } = await doApi("POST", "/droplets", body);
  const createData = parseJsonObj(createText);

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
    const data = parseJsonObj(text);
    const status = data?.droplet?.status;

    if (status === "active") {
      const v4Networks = toObjectArray(data?.droplet?.networks?.v4);
      const publicNet = v4Networks.find((n) => n.type === "public");
      if (publicNet?.ip_address) {
        doServerIp = isString(publicNet.ip_address) ? publicNet.ip_address : "";
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

export async function waitForCloudInit(ip?: string, _maxAttempts = 60): Promise<void> {
  const serverIp = ip || doServerIp;
  const selectedKeys = await ensureSshKeys();
  const keyOpts = getSshKeyOpts(selectedKeys);
  await sharedWaitForSsh({
    host: serverIp,
    user: "root",
    maxAttempts: 36,
    extraSshOpts: keyOpts,
  });

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
        ...SSH_BASE_OPTS,
        ...keyOpts,
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
        "pipe",
        "inherit",
        "inherit",
      ],
    },
  );

  const timeout = (timeoutSecs || 300) * 1000;
  const timer = setTimeout(() => killWithTimeout(proc), timeout);
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
        "pipe",
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
  const serverIp = ip || doServerIp;
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

  const data = parseJsonObj(text);
  if (data?.message) {
    logError(`Failed to destroy droplet ${id}: ${data.message}`);
    logWarn("The droplet may still be running and incurring charges.");
    logWarn(`Delete it manually at: ${DO_DASHBOARD_URL}`);
    throw new Error("Droplet deletion failed");
  }

  logInfo(`Droplet ${id} destroyed`);
}
