#!/bin/bash
set -eo pipefail

# Reddit Reply — Posts a comment to a Reddit thread.
# Called by trigger-server.ts via POST /reply.
#
# Required env vars:
#   POST_ID            — Reddit fullname of parent (e.g. t3_abc123)
#   REPLY_TEXT         — Comment text to post
#   REDDIT_CLIENT_ID   — Reddit OAuth app client ID
#   REDDIT_CLIENT_SECRET — Reddit OAuth app client secret
#   REDDIT_USERNAME    — Reddit account username
#   REDDIT_PASSWORD    — Reddit account password

if [[ -z "${POST_ID:-}" ]]; then
    echo '{"ok":false,"error":"POST_ID env var is required"}' >&2
    exit 1
fi

if [[ -z "${REPLY_TEXT:-}" ]]; then
    echo '{"ok":false,"error":"REPLY_TEXT env var is required"}' >&2
    exit 1
fi

if [[ -z "${REDDIT_CLIENT_ID:-}" || -z "${REDDIT_CLIENT_SECRET:-}" || -z "${REDDIT_USERNAME:-}" || -z "${REDDIT_PASSWORD:-}" ]]; then
    echo '{"ok":false,"error":"REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, and REDDIT_PASSWORD are all required"}' >&2
    exit 1
fi

# Use bun to authenticate + post comment (avoids shell escaping issues with reply text)
# Write script to temp file so credentials stay in env vars, not visible in ps output
REPLY_SCRIPT=$(mktemp /tmp/reply-XXXXXX.ts)
chmod 0600 "${REPLY_SCRIPT}"
cat > "${REPLY_SCRIPT}" <<'EOSCRIPT'
const clientId = process.env.REDDIT_CLIENT_ID!;
const clientSecret = process.env.REDDIT_CLIENT_SECRET!;
const username = process.env.REDDIT_USERNAME!;
const password = process.env.REDDIT_PASSWORD!;
const postId = process.env.POST_ID!;
const replyText = process.env.REPLY_TEXT!;

const auth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
const userAgent = 'spawn-growth:v1.0.0 (by /u/' + username + ')';

// Step 1: Get OAuth token
const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
  method: 'POST',
  headers: {
    'Authorization': 'Basic ' + auth,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
  },
  body: 'grant_type=password&username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password),
});

if (!tokenRes.ok) {
  console.log(JSON.stringify({ ok: false, error: 'Reddit auth failed: ' + tokenRes.status }));
  process.exit(1);
}

const tokenData = await tokenRes.json();
const token = tokenData.access_token;
if (!token) {
  console.log(JSON.stringify({ ok: false, error: 'No access_token in Reddit auth response' }));
  process.exit(1);
}

// Step 2: Post comment
const commentRes = await fetch('https://oauth.reddit.com/api/comment', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
  },
  body: 'thing_id=' + encodeURIComponent(postId) + '&text=' + encodeURIComponent(replyText),
});

if (!commentRes.ok) {
  const body = await commentRes.text();
  console.log(JSON.stringify({ ok: false, error: 'Reddit comment failed: ' + commentRes.status, body }));
  process.exit(1);
}

const commentData = await commentRes.json();

// Extract the comment URL from Reddit's response
const commentThing = commentData?.json?.data?.things?.[0]?.data;
const commentId = commentThing?.id ?? commentThing?.name ?? '';
const commentPermalink = commentThing?.permalink ?? '';
const commentUrl = commentPermalink ? 'https://reddit.com' + commentPermalink : '';

console.log(JSON.stringify({
  ok: true,
  commentId,
  commentUrl,
}));
EOSCRIPT

cleanup_reply() { rm -f "${REPLY_SCRIPT}" 2>/dev/null || true; }
trap cleanup_reply EXIT
exec bun run "${REPLY_SCRIPT}"
