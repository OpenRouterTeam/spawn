/**
 * X OAuth 2.0 PKCE Authorization — One-time setup.
 *
 * Starts a local server, opens the X authorization URL, receives the callback,
 * exchanges the code for access + refresh tokens, and saves them to state.db.
 *
 * Usage:
 *   X_CLIENT_ID=... X_CLIENT_SECRET=... bun run x-auth.ts
 *
 * After running, the SPA and growth scripts will use the stored tokens automatically.
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
const PORT = 8739;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "tweet.read tweet.write users.read offline.access";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[x-auth] X_CLIENT_ID and X_CLIENT_SECRET are required");
  process.exit(1);
}

const DB_PATH = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;

function openTokenDb(): Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir))
    mkdirSync(dir, {
      recursive: true,
    });
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS x_tokens (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      access_token   TEXT NOT NULL,
      refresh_token  TEXT NOT NULL,
      expires_at     INTEGER NOT NULL,
      updated_at     TEXT NOT NULL
    )
  `);
  return db;
}

function generatePKCE(): {
  verifier: string;
  challenge: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    verifier,
    challenge,
  };
}

const { verifier, challenge } = generatePKCE();
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://x.com/i/oauth2/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");

console.log("\n[x-auth] Open this URL in your browser to authorize:\n");
console.log(authUrl.toString());
console.log(`\n[x-auth] Waiting for callback on http://127.0.0.1:${PORT}...\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") {
      return new Response("Not found", {
        status: 404,
      });
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");

    if (returnedState !== state) {
      return new Response("State mismatch — possible CSRF. Try again.", {
        status: 400,
      });
    }
    if (!code) {
      const error = url.searchParams.get("error") ?? "unknown";
      return new Response(`Authorization denied: ${error}`, {
        status: 400,
      });
    }

    // Exchange code for tokens
    const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error(`[x-auth] Token exchange failed: ${err}`);
      return new Response(`Token exchange failed: ${err}`, {
        status: 500,
      });
    }

    const tokens: unknown = await tokenRes.json();
    const accessToken = (tokens as Record<string, unknown>).access_token;
    const refreshToken = (tokens as Record<string, unknown>).refresh_token;
    const expiresIn = (tokens as Record<string, unknown>).expires_in;

    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      console.error("[x-auth] Missing tokens in response");
      return new Response("Missing tokens in response", {
        status: 500,
      });
    }

    const expiresAt = Date.now() + (typeof expiresIn === "number" ? expiresIn : 7200) * 1000;

    // Save to DB
    const db = openTokenDb();
    db.run(
      `INSERT INTO x_tokens (id, access_token, refresh_token, expires_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         access_token  = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at    = excluded.expires_at,
         updated_at    = excluded.updated_at`,
      [
        accessToken,
        refreshToken,
        expiresAt,
        new Date().toISOString(),
      ],
    );
    db.close();

    console.log("[x-auth] Tokens saved to state.db");
    console.log("[x-auth] Done — you can close this tab.");

    setTimeout(() => {
      server.stop();
      process.exit(0);
    }, 500);

    return new Response("<html><body><h1>Authorized!</h1><p>Tokens saved. You can close this tab.</p></body></html>", {
      headers: {
        "Content-Type": "text/html",
      },
    });
  },
});
