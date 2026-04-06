/**
 * Reddit Fetch — Batch scanner for the growth agent.
 *
 * Authenticates with Reddit, fires all subreddit×query searches concurrently,
 * deduplicates (including against SPA's candidate DB), pre-fetches poster
 * comment histories, and outputs JSON to stdout.
 *
 * Env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const CLIENT_ID = process.env.REDDIT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET ?? "";
const USERNAME = process.env.REDDIT_USERNAME ?? "";
const PASSWORD = process.env.REDDIT_PASSWORD ?? "";
const USER_AGENT = `spawn-growth:v1.0.0 (by /u/${USERNAME})`;

if (!CLIENT_ID || !CLIENT_SECRET || !USERNAME || !PASSWORD) {
  console.error("Missing Reddit credentials");
  process.exit(1);
}

// Subreddits — shuffled each run so we don't always hit the same ones first
const SUBREDDITS = shuffle([
  "Vibecoding",
  "AIAgents",
  "ChatGPT",
  "SelfHosted",
  "programming",
  "commandline",
  "devops",
  "ClaudeAI",
  "webdev",
  "openai",
  "CodingWithAI",
]);

// Queries — shuffled each run for variety
const QUERIES = shuffle([
  "coding agent cloud",
  "coding agent server",
  "self host AI coding",
  "remote dev AI",
  "vibe coding setup",
  "deploy coding agent",
  "cloud dev environment AI",
  "AI coding assistant server",
  "run Claude Code remote",
  "coding agent VPS",
  "AI dev environment cheap",
]);

const MAX_CONCURRENT = 5;

interface RedditPost {
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

/** Load post IDs already seen by SPA from the candidates DB. */
function loadSeenPostIds(): Set<string> {
  const dbPath = `${process.env.HOME ?? "/tmp"}/.config/spawn/state.db`;
  if (!existsSync(dbPath)) return new Set();
  try {
    const db = new Database(dbPath, {
      readonly: true,
    });
    const rows = db
      .query<
        {
          post_id: string;
        },
        []
      >("SELECT post_id FROM candidates")
      .all();
    db.close();
    return new Set(rows.map((r) => r.post_id));
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

/** Authenticate and get bearer token. */
async function getToken(): Promise<string> {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`,
  });
  const data = (await res.json()) as Record<string, unknown>;
  const token = typeof data.access_token === "string" ? data.access_token : "";
  if (!token) {
    console.error("Reddit auth failed:", JSON.stringify(data));
    process.exit(1);
  }
  return token;
}

/** Fetch a Reddit API endpoint with auth. */
async function redditGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    console.error(`Reddit API ${res.status}: ${path}`);
    return null;
  }
  return res.json();
}

/** Extract posts from a Reddit listing response. */
function extractPosts(data: unknown): Map<string, RedditPost> {
  const posts = new Map<string, RedditPost>();
  if (!data || typeof data !== "object") return posts;
  const listing = data as Record<string, unknown>;
  const listingData = listing.data as Record<string, unknown> | undefined;
  const children = listingData?.children;
  if (!Array.isArray(children)) return posts;

  for (const child of children) {
    const c = child as Record<string, unknown>;
    const d = c.data as Record<string, unknown> | undefined;
    if (!d) continue;
    const id = String(d.name ?? "");
    if (!id || posts.has(id)) continue;

    posts.set(id, {
      title: String(d.title ?? ""),
      permalink: String(d.permalink ?? ""),
      subreddit: String(d.subreddit ?? ""),
      postId: id,
      score: Number(d.score ?? 0),
      numComments: Number(d.num_comments ?? 0),
      createdUtc: Number(d.created_utc ?? 0),
      selftext: String(d.selftext ?? "").slice(0, 2000),
      authorName: String(d.author ?? ""),
      authorComments: [],
    });
  }
  return posts;
}

/** Fetch a user's recent comments. */
async function fetchUserComments(token: string, username: string): Promise<string[]> {
  if (!username || username === "[deleted]") return [];
  const data = await redditGet(token, `/user/${username}/comments?limit=25&sort=new`);
  if (!data || typeof data !== "object") return [];
  const listing = data as Record<string, unknown>;
  const listingData = listing.data as Record<string, unknown> | undefined;
  const children = listingData?.children;
  if (!Array.isArray(children)) return [];

  return children
    .map((child) => {
      const c = child as Record<string, unknown>;
      const d = c.data as Record<string, unknown> | undefined;
      const body = String(d?.body ?? "").slice(0, 500);
      const sub = String(d?.subreddit ?? "");
      return sub ? `[r/${sub}] ${body}` : body;
    })
    .filter(Boolean);
}

async function main(): Promise<void> {
  const token = await getToken();
  console.error("[reddit-fetch] Authenticated");

  // Load already-seen post IDs from SPA's DB
  const seenIds = loadSeenPostIds();
  console.error(`[reddit-fetch] ${seenIds.size} posts already seen in DB`);

  // Build all search tasks
  const searchTasks: Array<() => Promise<Map<string, RedditPost>>> = [];

  for (const sub of SUBREDDITS) {
    for (const query of QUERIES) {
      const q = encodeURIComponent(query);
      searchTasks.push(async () => {
        const data = await redditGet(token, `/r/${sub}/search?q=${q}&sort=new&t=week&restrict_sr=true&limit=25`);
        return extractPosts(data);
      });
    }
  }

  // Direct mention search
  searchTasks.push(async () => {
    const data = await redditGet(token, "/search?q=openrouter+spawn&sort=new&t=week&limit=25");
    return extractPosts(data);
  });

  console.error(`[reddit-fetch] Firing ${searchTasks.length} searches (concurrency=${MAX_CONCURRENT})...`);

  const allResults = await pooled(searchTasks, MAX_CONCURRENT);

  // Merge, deduplicate, and filter out already-seen posts
  const allPosts = new Map<string, RedditPost>();
  let skippedSeen = 0;
  for (const resultMap of allResults) {
    for (const [id, post] of resultMap) {
      if (seenIds.has(id)) {
        skippedSeen++;
        continue;
      }
      if (!allPosts.has(id)) {
        allPosts.set(id, post);
      }
    }
  }

  console.error(`[reddit-fetch] Found ${allPosts.size} unique posts (${skippedSeen} already seen, skipped)`);

  // Pre-fetch poster comments for posts with some engagement
  const postsArray = [
    ...allPosts.values(),
  ];
  const worthQualifying = postsArray.filter((p) => p.score >= 2 || p.numComments >= 2);
  const uniqueAuthors = [
    ...new Set(worthQualifying.map((p) => p.authorName)),
  ];

  console.error(`[reddit-fetch] Fetching comments for ${uniqueAuthors.length} authors...`);

  const commentMap = new Map<string, string[]>();
  const commentTasks = uniqueAuthors.map((author) => async () => {
    const comments = await fetchUserComments(token, author);
    commentMap.set(author, comments);
  });
  await pooled(commentTasks, MAX_CONCURRENT);

  // Attach comments to posts
  for (const post of postsArray) {
    post.authorComments = commentMap.get(post.authorName) ?? [];
  }

  // Filter to posts with some engagement, sort by score descending
  const filtered = postsArray.filter((p) => p.score >= 2 || p.numComments >= 2);
  filtered.sort((a, b) => b.score - a.score);

  // Output JSON to stdout (trimmed to keep prompt size reasonable)
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
      authorComments: p.authorComments.slice(0, 5).map((c) => c.slice(0, 200)),
    })),
    postsScanned: allPosts.size,
  };

  console.log(JSON.stringify(output));
  console.error(`[reddit-fetch] Done — ${filtered.length} posts output`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
