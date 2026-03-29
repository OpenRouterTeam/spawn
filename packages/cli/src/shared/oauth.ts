// shared/oauth.ts — OpenRouter OAuth flow + API key management

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getErrorMessage, isString } from "@openrouter/spawn-shared";
import * as v from "valibot";
import { OAUTH_CODE_REGEX } from "./oauth-constants.js";
import { parseJsonObj, parseJsonWith } from "./parse.js";
import { getSpawnCloudConfigPath } from "./paths.js";
import { asyncTryCatchIf, isFileError, isNetworkError, tryCatch } from "./result.js";
import { logDebug, logError, logInfo, logStep, logWarn, openBrowser, prompt, retryOrQuit } from "./ui.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const OAuthKeySchema = v.object({
  key: v.string(),
});

// ─── Key Validation ──────────────────────────────────────────────────────────

async function verifyOpenrouterKey(apiKey: string): Promise<boolean> {
  if (!apiKey) {
    return false;
  }
  if (process.env.SPAWN_SKIP_API_VALIDATION || process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test") {
    return true;
  }

  const result = await asyncTryCatchIf(isNetworkError, async () => {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 200) {
      return true;
    }
    if (resp.status === 401 || resp.status === 403) {
      logError("OpenRouter API key is invalid or expired");
      logError("Get a new key at: https://openrouter.ai/settings/keys");
      return false;
    }
    return true; // unknown status = don't block
  });
  return result.ok ? result.data : true; // network error = skip validation
}

// ─── PKCE (S256) ────────────────────────────────────────────────────────────

/** Base64url-encode a Uint8Array (RFC 7636 Appendix A). */
function base64UrlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a cryptographically random code verifier (43 chars, URL-safe). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Derive the S256 code challenge: BASE64URL(SHA-256(verifier)). */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return base64UrlEncode(digest);
}

// ─── OAuth Flow via Bun.serve ────────────────────────────────────────────────

export function generateCsrfState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const OAUTH_CSS =
  "*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;color:#090a0b}@media(prefers-color-scheme:dark){body{background:#090a0b;color:#fafafa}}.card{text-align:center;max-width:400px;padding:2rem}.icon{font-size:2.5rem;margin-bottom:1rem}h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}p{font-size:.875rem;color:#6b7280}@media(prefers-color-scheme:dark){p{color:#9ca3af}}";

const SUCCESS_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Authentication Successful</h1><p>You can close this tab and return to your terminal.</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`;

const ERROR_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}h1{color:#dc2626}@media(prefers-color-scheme:dark){h1{color:#ef4444}}</style></head><body><div class="card"><div class="icon">&#10007;</div><h1>Authentication Failed</h1><p>Invalid or missing state parameter (CSRF protection). Please try again.</p></div></body></html>`;

const DENIAL_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}h1{color:#dc2626}@media(prefers-color-scheme:dark){h1{color:#ef4444}}</style></head><body><div class="card"><div class="icon">&#10007;</div><h1>Authorization Denied</h1><p>You denied access to OpenRouter. You can close this tab and return to your terminal.</p></div></body></html>`;

async function tryOauthFlow(callbackPort = 5180, agentSlug?: string, cloudSlug?: string): Promise<string | null> {
  logStep("Attempting OAuth authentication...");

  // Check network connectivity
  const reachable = await asyncTryCatchIf(isNetworkError, async () => {
    await fetch("https://openrouter.ai", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  });
  if (!reachable.ok) {
    logWarn("Cannot reach openrouter.ai — network may be unavailable");
    return null;
  }

  const csrfState = generateCsrfState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  let oauthCode: string | null = null;
  let oauthDenied = false;
  let server: ReturnType<typeof Bun.serve> | null = null;

  // Try ports in range
  let actualPort = callbackPort;
  for (let port = callbackPort; port < callbackPort + 10; port++) {
    const serveResult = tryCatch(() =>
      Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/callback") {
            // Check for OAuth denial / error
            const error = url.searchParams.get("error");
            if (error) {
              const desc = url.searchParams.get("error_description") || error;
              logError(`OpenRouter authorization denied: ${desc}`);
              oauthDenied = true;
              return new Response(DENIAL_HTML, {
                status: 403,
                headers: {
                  "Content-Type": "text/html",
                  Connection: "close",
                },
              });
            }
          }
          const code = url.searchParams.get("code");
          if (url.pathname === "/callback" && code) {
            // CSRF check
            if (url.searchParams.get("state") !== csrfState) {
              return new Response(ERROR_HTML, {
                status: 403,
                headers: {
                  "Content-Type": "text/html",
                  Connection: "close",
                },
              });
            }
            // Validate code format
            if (!OAUTH_CODE_REGEX.test(code)) {
              return new Response("<html><body><h1>Invalid OAuth Code</h1></body></html>", {
                status: 400,
                headers: {
                  "Content-Type": "text/html",
                },
              });
            }
            oauthCode = code;
            return new Response(SUCCESS_HTML, {
              headers: {
                "Content-Type": "text/html",
                Connection: "close",
              },
            });
          }
          return new Response("Waiting for OAuth callback...", {
            headers: {
              "Content-Type": "text/html",
            },
          });
        },
      }),
    );
    if (!serveResult.ok) {
      continue;
    }
    server = serveResult.data;
    actualPort = port;
    break;
  }

  if (!server) {
    logWarn(`Failed to start OAuth server — ports ${callbackPort}-${callbackPort + 9} may be in use`);
    return null;
  }

  logInfo(`OAuth server listening on port ${actualPort}`);

  const callbackUrl = `http://localhost:${actualPort}/callback`;
  let authUrl = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callbackUrl)}&state=${csrfState}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
  if (agentSlug) {
    authUrl += `&spawn_agent=${encodeURIComponent(agentSlug)}`;
  }
  if (cloudSlug) {
    authUrl += `&spawn_cloud=${encodeURIComponent(cloudSlug)}`;
  }
  logStep("Opening browser to authenticate with OpenRouter...");
  openBrowser(authUrl);

  // Wait up to 120 seconds
  logStep("Waiting for authentication in browser (timeout: 120s)...");
  const deadline = Date.now() + 120_000;
  while (!oauthCode && !oauthDenied && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  server.stop(true);

  if (oauthDenied) {
    logError("OAuth authorization was denied by the user");
    logError("Alternative: Use a manual API key instead");
    logError("  export OPENROUTER_API_KEY=sk-or-v1-...");
    return null;
  }

  if (!oauthCode) {
    logError("OAuth authentication timed out after 120 seconds");
    logError("Alternative: Use a manual API key instead");
    logError("  export OPENROUTER_API_KEY=sk-or-v1-...");
    return null;
  }

  // Exchange code for API key
  logStep("Exchanging OAuth code for API key...");
  const exchangeResult = await asyncTryCatchIf(isNetworkError, async () => {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: oauthCode,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = parseJsonWith(await resp.text(), OAuthKeySchema);
    if (data?.key) {
      logInfo("Successfully obtained OpenRouter API key via OAuth!");
      return data.key;
    }
    logError("Failed to exchange OAuth code for API key");
    return null;
  });
  if (!exchangeResult.ok) {
    logError("Failed to contact OpenRouter API");
    return null;
  }
  return exchangeResult.data;
}

// ─── API Key Persistence ─────────────────────────────────────────────────────

/** Save OpenRouter API key to ~/.config/spawn/openrouter.json so it persists across runs. */
async function saveOpenRouterKey(key: string): Promise<void> {
  const result = await asyncTryCatchIf(isFileError, async () => {
    const configPath = getSpawnCloudConfigPath("openrouter");
    mkdirSync(dirname(configPath), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          api_key: key,
        },
        null,
        2,
      ) + "\n",
      {
        mode: 0o600,
      },
    );
  });
  if (!result.ok) {
    logWarn("Could not save API key — you may need to re-authenticate next run");
    logDebug(getErrorMessage(result.error));
  }
}

/** Check whether a saved OpenRouter API key exists (without loading it). */
export function hasSavedOpenRouterKey(): boolean {
  return loadSavedOpenRouterKey() !== null;
}

/** Load a previously saved OpenRouter API key from ~/.config/spawn/openrouter.json. */
export function loadSavedOpenRouterKey(): string | null {
  const result = tryCatch(() => {
    const configPath = getSpawnCloudConfigPath("openrouter");
    const data = parseJsonObj(readFileSync(configPath, "utf-8"));
    if (!data) {
      return null;
    }
    const key = isString(data.api_key) ? data.api_key : "";
    if (key && /^sk-or-v1-[a-f0-9]{64}$/.test(key)) {
      return key;
    }
    return null;
  });
  return result.ok ? result.data : null;
}

// ─── Main API Key Acquisition ────────────────────────────────────────────────

async function promptAndValidateApiKey(): Promise<string | null> {
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    const key = await prompt("Enter your OpenRouter API key: ");
    if (!key) {
      logError("API key cannot be empty");
      continue;
    }
    // Validate format
    if (!/^sk-or-v1-[a-f0-9]{64}$/.test(key)) {
      logWarn("This doesn't look like an OpenRouter API key (expected format: sk-or-v1-...)");
      const confirm = await prompt("Use this key anyway? (y/N): ");
      if (!/^[Yy]$/.test(confirm)) {
        continue;
      }
    }
    return key;
  }
  logError("Too many failed attempts.");
  logError("Get your key from: https://openrouter.ai/settings/keys");
  return null;
}

export async function getOrPromptApiKey(agentSlug?: string, cloudSlug?: string): Promise<string> {
  process.stderr.write("\n");

  // 1. Check env var
  if (process.env.OPENROUTER_API_KEY) {
    logInfo("Using OpenRouter API key from environment");
    if (await verifyOpenrouterKey(process.env.OPENROUTER_API_KEY)) {
      return process.env.OPENROUTER_API_KEY;
    }
    logWarn("Environment key failed validation, prompting for a new one...");
  }

  // 2. Check saved key from previous session (only if user opted in via setup options)
  const reuseKeyEnabled = process.env.SPAWN_ENABLED_STEPS?.split(",").includes("reuse-api-key");
  if (reuseKeyEnabled) {
    const savedKey = loadSavedOpenRouterKey();
    if (savedKey) {
      logInfo("Using saved OpenRouter API key");
      if (await verifyOpenrouterKey(savedKey)) {
        process.env.OPENROUTER_API_KEY = savedKey;
        return savedKey;
      }
      logWarn("Saved key failed validation, prompting for a new one...");
    }
  }

  // 3. Try OAuth + manual fallback (retry loop — never exits unless user says no)
  for (;;) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Try OAuth first
      const key = await tryOauthFlow(5180, agentSlug, cloudSlug);
      if (key && (await verifyOpenrouterKey(key))) {
        process.env.OPENROUTER_API_KEY = key;
        await saveOpenRouterKey(key);
        return key;
      }

      // OAuth failed — fall through to manual entry
      process.stderr.write("\n");
      logWarn("Browser-based login was not completed.");
      logInfo("Get your API key from: https://openrouter.ai/settings/keys");
      process.stderr.write("\n");

      const manualKey = await promptAndValidateApiKey();
      if (manualKey && (await verifyOpenrouterKey(manualKey))) {
        process.env.OPENROUTER_API_KEY = manualKey;
        await saveOpenRouterKey(manualKey);
        return manualKey;
      }
    }

    logError("No valid API key after 3 attempts");
    await retryOrQuit("Try getting an API key again?");
  }
}
