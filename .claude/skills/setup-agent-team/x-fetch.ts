/**
 * X (Twitter) Fetch — Batch scanner for the growth agent.
 *
 * Authenticates with X API v2 Bearer token, runs search queries,
 * deduplicates (including against SPA's candidate DB), and outputs JSON
 * to stdout in the same shape as reddit-fetch.ts.
 *
 * Env vars: X_BEARER_TOKEN
 *
 * Budget: ~$0.30/day (3 queries x 20 results = 60 tweet reads at $0.005 each)
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const BEARER_TOKEN = process.env.X_BEARER_TOKEN ?? "";

if (!BEARER_TOKEN) {
  console.error("Missing X_BEARER_TOKEN");
  process.exit(1);
}

// Search queries — broad to maximize signal with limited budget (3 queries x 20 results)
const QUERIES = [
  '("coding agent" OR "AI coding") (cloud OR server OR VPS OR deploy) -is:retweet',
  '("Claude Code" OR "Codex CLI" OR "Kilo Code" OR "coding assistant") (remote OR "self-host") -is:retweet',
  "(openrouter OR spawn) (coding OR agent OR deploy) -is:retweet",
];

const MAX_RESULTS = 20;

interface XPost {
  title: string;
  permalink: string;
  subreddit: string;
  postId: string;
  score: number;
  numComments: number;
  createdUtc: number;
  selftext: string;
  authorName: string;
  authorComments: string[];
  platform: "x";
}

interface TweetPublicMetrics {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  impression_count: number;
}

interface TweetData {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id: string;
  public_metrics: TweetPublicMetrics;
}

interface UserData {
  id: string;
  username: string;
  name: string;
  description: string;
  public_metrics: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

interface SearchResponse {
  data?: TweetData[];
  includes?: {
    users?: UserData[];
  };
  meta?: {
    newest_id: string;
    oldest_id: string;
    result_count: number;
  };
}

/** Load post IDs already seen by SPA from the candidates DB. */
function loadSeenPostIds(): Set<string> {
  const dbPath = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;
  if (!existsSync(dbPath)) return new Set();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<{ post_id: string }, []>("SELECT post_id FROM candidates")
      .all();
    db.close();
    return new Set(rows.map((r) => r.post_id));
  } catch {
    return new Set();
  }
}

/** Fetch from X API v2 with Bearer auth. */
async function xGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.twitter.com${path}`, {
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`X API ${res.status}: ${path} — ${body.slice(0, 200)}`);
    return null;
  }
  return res.json();
}

/** Run a single search query and extract posts. */
async function searchTweets(query: string): Promise<Map<string, XPost>> {
  const posts = new Map<string, XPost>();
  const params = new URLSearchParams({
    query,
    max_results: String(MAX_RESULTS),
    "tweet.fields": "created_at,public_metrics,conversation_id,text,author_id",
    expansions: "author_id",
    "user.fields": "description,public_metrics,username,name",
  });

  const data = (await xGet(`/2/tweets/search/recent?${params}`)) as SearchResponse | null;
  if (!data?.data) return posts;

  // Build author lookup from includes
  const authors = new Map<string, UserData>();
  if (data.includes?.users) {
    for (const user of data.includes.users) {
      authors.set(user.id, user);
    }
  }

  for (const tweet of data.data) {
    const postId = `tweet_${tweet.id}`;
    if (posts.has(postId)) continue;

    const author = authors.get(tweet.author_id);
    const username = author?.username ?? "";
    const authorBio = author?.description ?? "";
    const followers = author?.public_metrics?.followers_count ?? 0;

    posts.set(postId, {
      title: tweet.text.slice(0, 100),
      permalink: `https://x.com/${username}/status/${tweet.id}`,
      subreddit: "x",
      postId,
      score: tweet.public_metrics?.like_count ?? 0,
      numComments: tweet.public_metrics?.reply_count ?? 0,
      createdUtc: Math.floor(new Date(tweet.created_at).getTime() / 1000),
      selftext: tweet.text,
      authorName: username,
      authorComments: authorBio
        ? [`[bio] ${authorBio}`, `[followers: ${followers}]`]
        : [],
      platform: "x",
    });
  }

  return posts;
}

async function main(): Promise<void> {
  console.error("[x-fetch] Authenticating with Bearer token");

  // Load already-seen post IDs from SPA's DB
  const seenIds = loadSeenPostIds();
  console.error(`[x-fetch] ${seenIds.size} posts already seen in DB`);

  // Run all search queries sequentially (be nice to rate limits)
  const allPosts = new Map<string, XPost>();
  let skippedSeen = 0;

  for (const query of QUERIES) {
    console.error(`[x-fetch] Searching: ${query.slice(0, 60)}...`);
    const results = await searchTweets(query);
    for (const [id, post] of results) {
      if (seenIds.has(id)) {
        skippedSeen++;
        continue;
      }
      if (!allPosts.has(id)) {
        allPosts.set(id, post);
      }
    }
  }

  console.error(
    `[x-fetch] Found ${allPosts.size} unique tweets (${skippedSeen} already seen, skipped)`,
  );

  // Filter to tweets with some engagement, sort by likes descending
  const postsArray = [...allPosts.values()];
  const filtered = postsArray.filter(
    (p) => p.score >= 1 || p.numComments >= 1,
  );
  filtered.sort((a, b) => b.score - a.score);

  // Output JSON to stdout
  const output = {
    posts: filtered.map((p) => ({
      title: p.title,
      permalink: p.permalink,
      subreddit: p.subreddit,
      postId: p.postId,
      score: p.score,
      numComments: p.numComments,
      createdUtc: p.createdUtc,
      selftext: p.selftext.slice(0, 500),
      authorName: p.authorName,
      authorComments: p.authorComments,
      platform: p.platform,
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
