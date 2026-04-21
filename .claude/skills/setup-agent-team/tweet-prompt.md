# Tweet Draft — Daily Spawn Update

You are writing a single tweet (max 280 characters) about the Spawn project (<https://github.com/OpenRouterTeam/spawn>) for a general audience — devs curious about AI but NOT infra/security nerds.

Spawn lets anyone spin up an AI coding agent (Claude, Codex, etc.) on a cheap cloud server with one command. That's it. Think "AI coding assistant in the cloud, ready in 30 seconds."

**Audience check**: a curious developer who doesn't know what `ps aux`, `OAuth`, `SigV4`, or `TLS` means, but does know what Claude / Codex / GitHub / cloud is.

## Past Tweet Decisions

Learn from what was previously approved, edited, or skipped:

TWEET_DECISIONS_PLACEHOLDER

## Recent Git Activity (last 7 days)

GIT_DATA_PLACEHOLDER

## Your Task

1. **Scan the git data** for the single most tweet-worthy item. Prioritize what a non-technical dev would care about:
   - New user-facing features (`feat(...)` commits) — MOST valuable, easiest to explain
   - New agent/cloud additions (T3 Code, Hetzner, etc.) — concrete and exciting
   - Avoid: low-level security fixes, OAuth changes, type-safety refactors, CI tweaks, internal plumbing
   - If the only notable commits are internal/infra, output `found: false` — no tweet is better than a boring technical tweet

2. **Draft exactly 1 tweet**, max 280 characters. Rules:
   - Casual, short, and plain-English. No jargon a beginner wouldn't get.
   - **BANNED terms in tweets**: `ps aux`, `OAuth`, `SigV4`, `TLS`, `CORS`, `RBAC`, `syscall`, `stdin`, `stdout`, `CLI args`, `process listing`, `temp file`, `env var`, `--flag names`, commit hashes, file paths. If you need any of these to explain the commit, pick a different commit or output found:false.
   - Allowed terms: Claude, Codex, Cursor, GitHub, cloud, agent, server, VM, one command, token, API.
   - Write like you're texting a friend who likes tech. "just added X", "now you can Y", "spin up a whole AI coding setup in 30 seconds"
   - No corporate speak, no "excited to announce", no "we're thrilled"
   - **NEVER use em dashes (—) or en dashes (–).** Use a period, comma, or rephrase.
   - At most 1 hashtag (only if it fits naturally)
   - OK to include `https://openrouter.ai/spawn`

3. **If nothing is tweet-worthy** (no notable changes, or all recent commits are internal/infra that would need banned jargon to explain), output `found: false`.

## Output Format

First, a human-readable summary:

```
=== TWEET DRAFT ===
Topic: {which commit/feature/fix this highlights}
Category: {feature | fix | best-practice}
Chars: {N}/280

Draft:
{the tweet text}
=== END TWEET ===
```

Then a machine-readable block:

```json:tweet
{
  "found": true,
  "type": "tweet",
  "tweetText": "{the tweet, max 280 chars}",
  "topic": "{brief description of what the tweet is about}",
  "category": "feature",
  "sourceCommits": ["abc1234def"],
  "charCount": 142
}
```

Or if nothing tweet-worthy:

```json:tweet
{"found": false, "type": "tweet", "reason": "no notable changes in last 7 days"}
```

## Rules

- Pick exactly 1 tweet per cycle. No ties, no "here are 3 options."
- MUST be under 280 characters. Count carefully.
- Do NOT use tools. Your only input is the git data above.
- A "no tweet" result is perfectly fine — quality over quantity.
