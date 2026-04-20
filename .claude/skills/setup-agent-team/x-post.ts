/**
 * X (Twitter) Post — Post a tweet via X API v2.
 *
 * Uses OAuth 1.0a to authenticate and POST /2/tweets.
 * Can post standalone tweets or replies (pass in_reply_to_tweet_id).
 *
 * Usage:
 *   X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=... \
 *   TWEET_TEXT="Hello world" bun run x-post.ts
 *
 * Optional env:
 *   REPLY_TO_TWEET_ID — if set, the tweet is posted as a reply to this tweet ID
 *
 * Outputs JSON: { "id": "...", "text": "..." } on success, exits 1 on failure.
 */

import { createHmac, randomBytes } from "node:crypto";
import * as v from "valibot";

const API_KEY = process.env.X_API_KEY ?? "";
const API_SECRET = process.env.X_API_SECRET ?? "";
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN ?? "";
const ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET ?? "";
const TWEET_TEXT = process.env.TWEET_TEXT ?? "";
const REPLY_TO = process.env.REPLY_TO_TWEET_ID ?? "";

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error("[x-post] Missing X API credentials");
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

const ErrorResponseSchema = v.object({
  detail: v.optional(v.string()),
  title: v.optional(v.string()),
  errors: v.optional(
    v.array(
      v.object({
        message: v.optional(v.string()),
      }),
    ),
  ),
});

/**
 * Generate OAuth 1.0a Authorization header for X API requests.
 */
function generateOAuthHeader(method: string, url: string, body?: string): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  // For POST with JSON body, only OAuth params go into the signature base
  const allParams = {
    ...oauthParams,
  };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`).join("&");

  const signatureBase = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_TOKEN_SECRET)}`;
  const signature = createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

async function postTweet(): Promise<void> {
  const url = "https://api.x.com/2/tweets";

  const payload: Record<string, unknown> = {
    text: TWEET_TEXT,
  };
  if (REPLY_TO) {
    payload.reply = {
      in_reply_to_tweet_id: REPLY_TO,
    };
  }

  const body = JSON.stringify(payload);
  const authHeader = generateOAuthHeader("POST", url, body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": "spawn-growth/1.0",
    },
    body,
  });

  const json: unknown = await res.json();

  if (!res.ok) {
    const err = v.safeParse(ErrorResponseSchema, json);
    const detail = err.success
      ? (err.output.detail ?? err.output.errors?.[0]?.message ?? `HTTP ${res.status}`)
      : `HTTP ${res.status}`;
    console.error(`[x-post] Failed: ${detail}`);
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
