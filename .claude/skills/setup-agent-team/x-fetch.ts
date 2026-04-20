/**
 * X (Twitter) Fetch — Search for Spawn/OpenRouter mentions on X.
 *
 * Uses X API v2 with OAuth 2.0 Bearer tokens (stored in state.db by x-auth.ts).
 * Auto-refreshes tokens when expired. Gracefully exits empty if no tokens.
 *
 * Env vars: X_CLIENT_ID, X_CLIENT_SECRET (for token refresh)
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as v from "valibot";

const CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
const DB_PATH = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;

// Graceful skip if credentials are not configured
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[x-fetch] No X_CLIENT_ID/SECRET configured — outputting empty results");
  console.log(
    JSON.stringify({
      posts: [],
      postsScanned: 0,
    }),
  );
  process.exit(0);
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

const TokenResponseSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  expires_in: v.optional(v.number()),
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

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Fisher-Yates shuffle. */
function shuffle<T>(arr: T[]): T[] {
  const a = [
    ...arr,
  ];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [
      a[j],
      a[i],
    ];
  }
  return a;
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
    console.error(`[x-fetch] Token refresh failed: ${res.status}`);
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

async function getAccessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() > tokens.expiresAt - 300_000) {
    const refreshed = await refreshToken(tokens.refreshToken);
    return refreshed?.accessToken ?? null;
  }
  return tokens.accessToken;
}

/** Search X API v2 for recent tweets matching a query. */
async function searchTweets(query: string, accessToken: string): Promise<XPost[]> {
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

  const res = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
  if (!existsSync(DB_PATH)) return new Set();
  try {
    const db = new Database(DB_PATH, {
      readonly: true,
    });
    const rows = db
      .query<
        {
          source_tweet_id: string;
        },
        []
      >("SELECT source_tweet_id FROM tweets WHERE source_tweet_id IS NOT NULL")
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
    Array.from(
      {
        length: Math.min(limit, tasks.length),
      },
      () => worker(),
    ),
  );
  return results;
}

async function main(): Promise<void> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("[x-fetch] No valid tokens — run x-auth.ts first");
    console.log(
      JSON.stringify({
        posts: [],
        postsScanned: 0,
      }),
    );
    process.exit(0);
  }
  console.error("[x-fetch] Authenticated");

  const seenIds = loadSeenTweetIds();
  console.error(`[x-fetch] ${seenIds.size} tweets already seen in DB`);

  const searchTasks = QUERIES.map((query) => () => searchTweets(query, accessToken));

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

  const postsArray = [
    ...allPosts.values(),
  ];
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
