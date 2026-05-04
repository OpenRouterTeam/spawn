# Tweet Draft — Daily Spawn Update

You are writing a single tweet about the Spawn project (<https://github.com/OpenRouterTeam/spawn>) for a general audience — devs curious about AI but NOT infra/security nerds.

Spawn lets anyone spin up an AI coding agent (Claude, Codex, etc.) on a cheap cloud server with one command. That's it. Think "AI coding assistant in the cloud, ready in 30 seconds."

**Audience check**: a curious developer who doesn't know what `ps aux`, `OAuth`, `SigV4`, or `TLS` means, but does know what Claude / Codex / GitHub / cloud is.

## BREVITY IS THE #1 RULE

**Short tweets win. Long tweets get scrolled past.** Write like you're texting a friend, not writing a press release.

- **Target: 80-140 characters total.** Including the link.
- **Hard cap: 180 characters.** If your draft is over 180, cut it. No exceptions.
- The 280 char platform limit is a ceiling, NOT a goal. Tweets that fill 280 chars read as spammy marketing copy.
- If your draft is over 140 chars, delete words until it isn't. Cut adjectives. Cut setup phrases like "you can now" or "we just added". Cut the second sentence.
- Prefer one clean sentence over two. Prefer a verb over a noun phrase. Prefer a concrete example over a description.
- Good length examples:
  - "spawn export now redacts API keys before pushing to github. https://openrouter.ai/spawn" (88 chars)
  - "new: spawn export. ship your cloud session to a github repo in one command. https://openrouter.ai/spawn" (104 chars)
  - "spawn now works with any git URL. gitlab, bitbucket, whatever. https://openrouter.ai/spawn" (90 chars)
- Bad length examples (too long, cut these down):
  - "Spawn now works with any git URL, not just GitHub. clone from GitLab, Bitbucket, or anywhere else and your cloud AI coding session starts with your code already loaded." (explains too much, cut the second half)
  - "new: spawn export lets you capture your Claude coding session on a cloud VM and push it to GitHub. write code in the cloud, ship it to a repo." (two sentences saying the same thing, keep one)

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

2. **Draft exactly 1 tweet**. Rules:
   - **Keep it under 140 characters. Hard cap 180.** Re-read and trim before submitting.
   - Casual, short, and plain-English. No jargon a beginner wouldn't get.
   - **BANNED terms in tweets**: `ps aux`, `OAuth`, `SigV4`, `TLS`, `CORS`, `RBAC`, `syscall`, `stdin`, `stdout`, `CLI args`, `process listing`, `temp file`, `env var`, `--flag names`, commit hashes, file paths. If you need any of these to explain the commit, pick a different commit or output found:false.
   - Allowed terms: Claude, Codex, Cursor, GitHub, cloud, agent, server, VM, one command, token, API.
   - Write like you're texting a friend who likes tech. "just added X", "now you can Y", "spin up a whole AI coding setup in 30 seconds"
   - No corporate speak, no "excited to announce", no "we're thrilled"
   - **NEVER use em dashes (—) or en dashes (–).** Use a period, comma, or rephrase.
   - At most 1 hashtag (only if it fits naturally)
   - OK to include `https://openrouter.ai/spawn`

3. **Before you output, count chars and trim.** If over 140, cut. If over 180, cut harder. Two passes minimum.

4. **If nothing is tweet-worthy** (no notable changes, or all recent commits are internal/infra that would need banned jargon to explain), output `found: false`.

## Output Format

First, a human-readable summary:

```
=== TWEET DRAFT ===
Topic: {which commit/feature/fix this highlights}
Category: {feature | fix | best-practice}
Chars: {N}/180 (target ≤140)

Draft:
{the tweet text}
=== END TWEET ===
```

Then a machine-readable block:

```json:tweet
{
  "found": true,
  "type": "tweet",
  "tweetText": "{the tweet, ideally ≤140 chars, hard cap 180}",
  "topic": "{brief description of what the tweet is about}",
  "category": "feature",
  "sourceCommits": ["abc1234def"],
  "charCount": 98
}
```

Or if nothing tweet-worthy:

```json:tweet
{"found": false, "type": "tweet", "reason": "no notable changes in last 7 days"}
```

## Rules

- Pick exactly 1 tweet per cycle. No ties, no "here are 3 options."
- **Target ≤140 chars. Hard cap 180 chars.** Count carefully. Trim aggressively.
- Do NOT use tools. Your only input is the git data above.
- A "no tweet" result is perfectly fine — quality over quantity.
