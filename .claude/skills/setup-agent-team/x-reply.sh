#!/bin/bash
set -eo pipefail

# X (Twitter) Reply — Posts a reply tweet to a thread.
# Called by trigger-server.ts via POST /x-reply.
#
# Required env vars:
#   TWEET_ID           — Tweet ID to reply to (numeric string)
#   REPLY_TEXT         — Reply text to post
#   X_API_KEY          — X OAuth 1.0a consumer key
#   X_API_SECRET       — X OAuth 1.0a consumer secret
#   X_ACCESS_TOKEN     — X OAuth 1.0a access token
#   X_ACCESS_SECRET    — X OAuth 1.0a access token secret

if [[ -z "${TWEET_ID:-}" ]]; then
    echo '{"ok":false,"error":"TWEET_ID env var is required"}' >&2
    exit 1
fi

if [[ -z "${REPLY_TEXT:-}" ]]; then
    echo '{"ok":false,"error":"REPLY_TEXT env var is required"}' >&2
    exit 1
fi

if [[ -z "${X_API_KEY:-}" || -z "${X_API_SECRET:-}" || -z "${X_ACCESS_TOKEN:-}" || -z "${X_ACCESS_SECRET:-}" ]]; then
    echo '{"ok":false,"error":"X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, and X_ACCESS_SECRET are all required"}' >&2
    exit 1
fi

# Use bun for OAuth 1.0a signing + HTTP request (HMAC-SHA1 is non-trivial in bash)
REPLY_SCRIPT=$(mktemp /tmp/x-reply-XXXXXX.ts)
chmod 0600 "${REPLY_SCRIPT}"
cat > "${REPLY_SCRIPT}" <<'EOSCRIPT'
import { createHmac, randomBytes } from "node:crypto";

const apiKey = process.env.X_API_KEY!;
const apiSecret = process.env.X_API_SECRET!;
const accessToken = process.env.X_ACCESS_TOKEN!;
const accessSecret = process.env.X_ACCESS_SECRET!;
const tweetId = process.env.TWEET_ID!;
const replyText = process.env.REPLY_TEXT!;

const API_URL = "https://api.twitter.com/2/tweets";

/** Percent-encode per RFC 3986 (OAuth 1.0a requirement). */
function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Generate OAuth 1.0a Authorization header. */
function buildOAuthHeader(method: string, url: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };

  // Build signature base string (no body params for JSON content type)
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join("&");

  const baseString = `${method}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessSecret)}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  oauthParams.oauth_signature = signature;

  const header = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${header}`;
}

// Post the reply
const authHeader = buildOAuthHeader("POST", API_URL);

const body = JSON.stringify({
  text: replyText,
  reply: {
    in_reply_to_tweet_id: tweetId,
  },
});

const res = await fetch(API_URL, {
  method: "POST",
  headers: {
    Authorization: authHeader,
    "Content-Type": "application/json",
  },
  body,
});

if (!res.ok) {
  const errBody = await res.text();
  console.log(
    JSON.stringify({
      ok: false,
      error: `X API reply failed: ${res.status}`,
      body: errBody.slice(0, 500),
    }),
  );
  process.exit(1);
}

const data = (await res.json()) as Record<string, unknown>;
const tweetData = data.data as Record<string, unknown> | undefined;
const newTweetId = typeof tweetData?.id === "string" ? tweetData.id : "";

console.log(
  JSON.stringify({
    ok: true,
    tweetId: newTweetId,
    tweetUrl: newTweetId
      ? `https://x.com/i/status/${newTweetId}`
      : "",
  }),
);
EOSCRIPT

cleanup_reply() { rm -f "${REPLY_SCRIPT}" 2>/dev/null || true; }
trap cleanup_reply EXIT
exec bun run "${REPLY_SCRIPT}"
