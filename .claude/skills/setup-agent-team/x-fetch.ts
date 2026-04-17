/**
 * X (Twitter) Fetch — Search for Spawn/OpenRouter mentions on X.
 *
 * Uses X API v2 to find tweets mentioning Spawn, OpenRouter, or related topics.
 * Gracefully exits with empty results if credentials are not configured.
 *
 * Env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 */

import { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as v from "valibot";

const API_KEY = process.env.X_API_KEY ?? "";
const API_SECRET = process.env.X_API_SECRET ?? "";
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN ?? "";
const ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET ?? "";

// Graceful skip if credentials are not configured
if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error("[x-fetch] No X API credentials configured — outputting empty results");
  console.log(JSON.stringify({ posts: [], postsScanned: 0 }));
  process.exit(0);
}

// Validate credential format — reject newlines that could corrupt headers
if (/[\r\n]/.test(API_KEY) || /[\r\n]/.test(API_SECRET)) {
  console.error("Invalid X_API_KEY / X_API_SECRET: must not contain newlines");
  process.exit(1);
}

// Search queries — shuffled each run for variety
const QUERIES = shuffle([
  "openrouter spawn",
  "spawn cloud agent",
  '"cloud coding agent"',
  '"remote dev environment" AI',
  '"claude code" remote server',
  "codex CLI cloud",
  "@OpenRouterTeam",
]);

const MAX_RESULTS_PER_QUERY = 25;
const MAX_CONCURRENT = 3;

/** X API v2 tweet schema. */
const XTweetSchema = v.object({
  id: v.string(),
  text: v.string(),
  created_at: v.optional(v.string()),
  author_id: v.optional(v.string()),
  public_metrics: v.optional(
    v.object({
      like_count: v.optional(v.number()),
      retweet_count: v.optional(v.number()),
      reply_count: v.optional(v.number()),
      quote_count: v.optional(v.number()),
    }),
  ),
});

const XUserSchema = v.object({
  id: v.string(),
  username: v.string(),
});

const XSearchResponseSchema = v.object({
  data: v.optional(v.array(XTweetSchema)),
  includes: v.optional(
    v.object({
      users: v.optional(v.array(XUserSchema)),
    }),
  ),
  meta: v.optional(
    v.object({
      result_count: v.optional(v.number()),
    }),
  ),
});

interface XPost {
  tweetId: string;
  text: string;
  authorUsername: string;
  authorId: string;
  createdAt: string;
  likes: number;
  retweets: number;
  replies: number;
  url: string;
}

/** Fisher-Yates shuffle. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate OAuth 1.0a signature for X API requests.
 * Reference: https://developer.x.com/en/docs/authentication/oauth-1-0a
 */
function generateOAuthHeader(method: string, url: string, params: Record<string, string>): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  const allParams = { ...params, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join("&");

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

/** Search X API v2 for recent tweets matching a query. */
async function searchTweets(query: string): Promise<XPost[]> {
  const baseUrl = "https://api.x.com/2/tweets/search/recent";
  const params: Record<string, string> = {
    query,
    max_results: String(MAX_RESULTS_PER_QUERY),
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "username",
  };

  const queryString = Object.entries(params)
    .map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`)
    .join("&");
  const fullUrl = `${baseUrl}?${queryString}`;

  const authHeader = generateOAuthHeader("GET", baseUrl, params);

  const res = await fetch(fullUrl, {
    headers: {
      Authorization: authHeader,
      "User-Agent": "spawn-growth/1.0",
    },
  });

  if (!res.ok) {
    console.error(`[x-fetch] X API ${res.status}: ${query}`);
    return [];
  }

  const json: unknown = await res.json();
  const parsed = v.safeParse(XSearchResponseSchema, json);
  if (!parsed.success || !parsed.output.data) return [];

  const users = new Map<string, string>();
  for (const u of parsed.output.includes?.users ?? []) {
    users.set(u.id, u.username);
  }

  return parsed.output.data.map((tweet) => {
    const username = users.get(tweet.author_id ?? "") ?? "unknown";
    return {
      tweetId: tweet.id,
      text: tweet.text,
      authorUsername: username,
      authorId: tweet.author_id ?? "",
      createdAt: tweet.created_at ?? "",
      likes: tweet.public_metrics?.like_count ?? 0,
      retweets: tweet.public_metrics?.retweet_count ?? 0,
      replies: tweet.public_metrics?.reply_count ?? 0,
      url: `https://x.com/${username}/status/${tweet.id}`,
    };
  });
}

/** Load tweet IDs already processed from the tweets DB. */
function loadSeenTweetIds(): Set<string> {
  const dbPath = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;
  if (!existsSync(dbPath)) return new Set();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ source_tweet_id: string }, []>(
        "SELECT source_tweet_id FROM tweets WHERE source_tweet_id IS NOT NULL",
      )
      .all();
    db.close();
    return new Set(rows.map((r) => r.source_tweet_id));
  } catch {
    return new Set();
  }
}

/** Simple concurrency limiter. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return results;
}

async function main(): Promise<void> {
  console.error("[x-fetch] Authenticated");

  const seenIds = loadSeenTweetIds();
  console.error(`[x-fetch] ${seenIds.size} tweets already seen in DB`);

  const searchTasks = QUERIES.map(
    (query) => () => searchTweets(query),
  );

  console.error(`[x-fetch] Firing ${searchTasks.length} searches (concurrency=${MAX_CONCURRENT})...`);

  const allResults = await pooled(searchTasks, MAX_CONCURRENT);

  const allPosts = new Map<string, XPost>();
  let skippedSeen = 0;
  for (const results of allResults) {
    for (const post of results) {
      if (seenIds.has(post.tweetId)) {
        skippedSeen++;
        continue;
      }
      if (!allPosts.has(post.tweetId)) {
        allPosts.set(post.tweetId, post);
      }
    }
  }

  console.error(`[x-fetch] Found ${allPosts.size} unique tweets (${skippedSeen} already seen, skipped)`);

  const postsArray = [...allPosts.values()];
  const filtered = postsArray.filter((p) => p.likes >= 1 || p.replies >= 1);
  filtered.sort((a, b) => b.likes - a.likes);

  const output = {
    posts: filtered.map((p) => ({
      tweetId: p.tweetId,
      text: p.text.slice(0, 500),
      authorUsername: p.authorUsername,
      createdAt: p.createdAt,
      likes: p.likes,
      retweets: p.retweets,
      replies: p.replies,
      url: p.url,
    })),
    postsScanned: allPosts.size,
  };

  console.log(JSON.stringify(output));
  console.error(`[x-fetch] Done — ${filtered.length} tweets output`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
