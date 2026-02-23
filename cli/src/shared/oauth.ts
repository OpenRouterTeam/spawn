// shared/oauth.ts — OpenRouter OAuth flow + API key management

import * as v from "valibot";
import { parseJsonWith } from "./parse";
import { logInfo, logWarn, logError, logStep, prompt, openBrowser, validateModelId } from "./ui";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const OAuthKeySchema = v.object({ key: v.string() });

// ─── Key Validation ──────────────────────────────────────────────────────────

export async function verifyOpenrouterKey(apiKey: string): Promise<boolean> {
  if (!apiKey) {
    return false;
  }
  if (process.env.SPAWN_SKIP_API_VALIDATION || process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test") {
    return true;
  }

  try {
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
  } catch {
    return true; // network error = skip validation
  }
}

// ─── OAuth Flow via Bun.serve ────────────────────────────────────────────────

function generateCsrfState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const OAUTH_CSS =
  "*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;color:#090a0b}@media(prefers-color-scheme:dark){body{background:#090a0b;color:#fafafa}}.card{text-align:center;max-width:400px;padding:2rem}.icon{font-size:2.5rem;margin-bottom:1rem}h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}p{font-size:.875rem;color:#6b7280}@media(prefers-color-scheme:dark){p{color:#9ca3af}}";

const SUCCESS_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}</style></head><body><div class="card"><div class="icon">&#10003;</div><h1>Authentication Successful</h1><p>You can close this tab and return to your terminal.</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>`;

const ERROR_HTML = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${OAUTH_CSS}h1{color:#dc2626}@media(prefers-color-scheme:dark){h1{color:#ef4444}}</style></head><body><div class="card"><div class="icon">&#10007;</div><h1>Authentication Failed</h1><p>Invalid or missing state parameter (CSRF protection). Please try again.</p></div></body></html>`;

async function tryOauthFlow(callbackPort = 5180, agentSlug?: string, cloudSlug?: string): Promise<string | null> {
  logStep("Attempting OAuth authentication...");

  // Check network connectivity
  try {
    await fetch("https://openrouter.ai", {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    logWarn("Cannot reach openrouter.ai — network may be unavailable");
    return null;
  }

  const csrfState = generateCsrfState();
  let oauthCode: string | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  // Try ports in range
  let actualPort = callbackPort;
  for (let p = callbackPort; p < callbackPort + 10; p++) {
    try {
      server = Bun.serve({
        port: p,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/callback" && url.searchParams.get("code")) {
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
            const code = url.searchParams.get("code")!;
            // Validate code format
            if (!/^[a-zA-Z0-9_-]{16,128}$/.test(code)) {
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
      });
      actualPort = p;
      break;
    } catch {}
  }

  if (!server) {
    logWarn(`Failed to start OAuth server — ports ${callbackPort}-${callbackPort + 9} may be in use`);
    return null;
  }

  logInfo(`OAuth server listening on port ${actualPort}`);

  const callbackUrl = `http://localhost:${actualPort}/callback`;
  let authUrl = `https://openrouter.ai/auth?callback_url=${callbackUrl}&state=${csrfState}`;
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
  while (!oauthCode && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  server.stop(true);

  if (!oauthCode) {
    logError("OAuth authentication timed out after 120 seconds");
    logError("Alternative: Use a manual API key instead");
    logError("  export OPENROUTER_API_KEY=sk-or-v1-...");
    return null;
  }

  // Exchange code for API key
  logStep("Exchanging OAuth code for API key...");
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: oauthCode,
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
  } catch (_err) {
    logError("Failed to contact OpenRouter API");
    return null;
  }
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

  // 2. Try OAuth + manual fallback (3 attempts)
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Try OAuth first
    const key = await tryOauthFlow(5180, agentSlug, cloudSlug);
    if (key && (await verifyOpenrouterKey(key))) {
      process.env.OPENROUTER_API_KEY = key;
      return key;
    }

    // OAuth failed, offer manual entry
    process.stderr.write("\n");
    logWarn("Browser-based OAuth login was not completed.");
    logInfo("You can paste an API key instead. Create one at: https://openrouter.ai/settings/keys");
    process.stderr.write("\n");

    const choice = await prompt("Paste your API key manually? (Y/n): ");
    if (/^[Nn]$/.test(choice)) {
      logError("Authentication cancelled. An OpenRouter API key is required.");
      throw new Error("No API key");
    }

    process.stderr.write("\n");
    logInfo("Manual API Key Entry");
    logInfo("Get your API key from: https://openrouter.ai/settings/keys");
    process.stderr.write("\n");

    const manualKey = await promptAndValidateApiKey();
    if (manualKey && (await verifyOpenrouterKey(manualKey))) {
      process.env.OPENROUTER_API_KEY = manualKey;
      return manualKey;
    }
  }

  logError("No valid API key after 3 attempts");
  throw new Error("API key acquisition failed");
}

// ─── Model Selection ─────────────────────────────────────────────────────────

export async function getModelIdInteractive(defaultModel = "openrouter/auto", agentName?: string): Promise<string> {
  // Check env var first
  if (process.env.MODEL_ID) {
    if (!validateModelId(process.env.MODEL_ID)) {
      logError("MODEL_ID environment variable contains invalid characters");
      throw new Error("Invalid MODEL_ID");
    }
    return process.env.MODEL_ID;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    process.stderr.write("\n");
    logInfo("Browse models at: https://openrouter.ai/models");
    if (agentName) {
      logInfo(`Which model would you like to use with ${agentName}?`);
    } else {
      logInfo("Which model would you like to use?");
    }

    const modelId = (await prompt(`Enter model ID [${defaultModel}]: `)) || defaultModel;

    if (!validateModelId(modelId)) {
      logError("Invalid characters in model ID, try again");
      continue;
    }

    return modelId;
  }

  logError("No valid model after 3 attempts");
  throw new Error("Model selection failed");
}
