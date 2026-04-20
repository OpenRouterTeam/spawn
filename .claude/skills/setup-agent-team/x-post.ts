/**
 * X (Twitter) Post — Post a tweet via X API v2 (OAuth 2.0).
 *
 * Reads tokens from state.db (written by x-auth.ts), auto-refreshes if expired.
 *
 * Usage:
 *   X_CLIENT_ID=... X_CLIENT_SECRET=... TWEET_TEXT="Hello world" bun run x-post.ts
 *
 * Optional env:
 *   REPLY_TO_TWEET_ID — if set, the tweet is posted as a reply to this tweet ID
 *
 * Outputs JSON: { "id": "...", "text": "..." } on success, exits 1 on failure.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as v from "valibot";

const CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
const TWEET_TEXT = process.env.TWEET_TEXT ?? "";
const REPLY_TO = process.env.REPLY_TO_TWEET_ID ?? "";
const DB_PATH = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[x-post] X_CLIENT_ID and X_CLIENT_SECRET are required");
  process.exit(1);
}

if (!TWEET_TEXT) {
  console.error("[x-post] TWEET_TEXT is empty");
  process.exit(1);
}

if (TWEET_TEXT.length > 280) {
  console.error(`[x-post] Tweet too long (${TWEET_TEXT.length} chars, max 280)`);
  process.exit(1);
}

const PostResponseSchema = v.object({
  data: v.object({
    id: v.string(),
    text: v.string(),
  }),
});

const TokenResponseSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
});

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadTokens(): StoredTokens | null {
  if (!existsSync(DB_PATH)) return null;
  try {
    const db = new Database(DB_PATH, {
      readonly: true,
    });
    const row = db
      .query<
        {
          access_token: string;
          refresh_token: string;
          expires_at: number;
        },
        []
      >("SELECT access_token, refresh_token, expires_at FROM x_tokens WHERE id = 1")
      .get();
    db.close();
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  const db = new Database(DB_PATH);
  db.run(
    `INSERT INTO x_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at    = excluded.expires_at,
       updated_at    = excluded.updated_at`,
    [
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
      new Date().toISOString(),
    ],
  );
  db.close();
}

async function refreshToken(currentRefresh: string): Promise<StoredTokens | null> {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefresh,
    }),
  });

  if (!res.ok) {
    console.error(`[x-post] Token refresh failed: ${res.status} ${await res.text()}`);
    return null;
  }

  const json: unknown = await res.json();
  const parsed = v.safeParse(TokenResponseSchema, json);
  if (!parsed.success) return null;

  const newTokens: StoredTokens = {
    accessToken: parsed.output.access_token,
    refreshToken: parsed.output.refresh_token ?? currentRefresh,
    expiresAt: Date.now() + (parsed.output.expires_in ?? 7200) * 1000,
  };
  saveTokens(newTokens);
  return newTokens;
}

async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) {
    console.error("[x-post] No tokens in state.db — run x-auth.ts first");
    process.exit(1);
  }

  if (Date.now() > tokens.expiresAt - 300_000) {
    console.error("[x-post] Token expired, refreshing...");
    const refreshed = await refreshToken(tokens.refreshToken);
    if (!refreshed) {
      console.error("[x-post] Refresh failed — re-run x-auth.ts");
      process.exit(1);
    }
    return refreshed.accessToken;
  }

  return tokens.accessToken;
}

async function postTweet(): Promise<void> {
  const accessToken = await getAccessToken();
  const url = "https://api.x.com/2/tweets";

  const payload: Record<string, unknown> = {
    text: TWEET_TEXT,
  };
  if (REPLY_TO) {
    payload.reply = {
      in_reply_to_tweet_id: REPLY_TO,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "spawn-growth/1.0",
    },
    body: JSON.stringify(payload),
  });

  const json: unknown = await res.json();

  if (!res.ok) {
    console.error(`[x-post] Failed: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    process.exit(1);
  }

  const parsed = v.safeParse(PostResponseSchema, json);
  if (!parsed.success) {
    console.error("[x-post] Unexpected response shape");
    console.error(JSON.stringify(json));
    process.exit(1);
  }

  console.log(JSON.stringify(parsed.output.data));
  console.error(`[x-post] Posted tweet ${parsed.output.data.id}`);
}

postTweet().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
