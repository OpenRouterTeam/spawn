---
name: setup-agent-team
description: Set up the Bun trigger server on a Sprite and configure GitHub Actions to wake it on a schedule, on events, or manually.
disable-model-invocation: true
argument-hint: "[service-name] [target-script-path]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Setup Trigger Service

Set up a **Bun-based HTTP trigger server** on a Sprite VM and configure a **GitHub Actions workflow** to wake the Sprite on a cron schedule, GitHub events, or manual dispatch.

**IMPORTANT: This skill is designed to be run INSIDE a Sprite VM.** The Claude Code instance invoking this skill should already be running inside Sprite, with access to `sprite-env` commands.

The user wants to set up a trigger service for: **$ARGUMENTS**

## Overview

Sprites pause when idle to save resources. This skill sets up a trigger server that GitHub Actions can call to wake the Sprite and run a script:

```
GitHub Actions (cron / events / manual)
  -> curl POST $SPRITE_URL/trigger (with Bearer token)
    -> Sprite wakes from pause (http-port auto-start)
      -> trigger-server.ts validates Bearer token
        -> target script runs (single cycle, then exits)
          -> Sprite goes idle again until next trigger
```

**How it works:**
- The Sprite's public URL is set to `auth: "public"` so GitHub Actions can reach it
- The trigger server listens on port 8080 with `--http-port 8080` (auto-starts on HTTP traffic)
- A `TRIGGER_SECRET` bearer token protects the `/trigger` endpoint from unauthorized access
- The Sprite URL + trigger secret are stored as GitHub Actions secrets

## Prerequisites

- You are running Claude Code **inside a Sprite VM**
- `sprite-env` commands are available
- `bun` is installed (comes with Sprite by default)
- `gh` CLI is installed and authenticated
- Repository has write access for setting secrets
- A `SPRITE_TOKEN` (from https://sprites.dev/account) for setting the Sprite's URL auth to public

## Step 1: Verify trigger-server.ts

The trigger server lives at:
`/home/sprite/spawn/.claude/skills/setup-agent-team/trigger-server.ts`

It reads env vars:
- `TRIGGER_SECRET` (required) — Bearer token for authenticating requests
- `TARGET_SCRIPT` (required) — Absolute path to the script to run on trigger
- `REPO_ROOT` (optional) — Working directory for the script (defaults to script's parent dir)
- `MAX_CONCURRENT` (optional) — Max parallel runs (default: `1`)
- `RUN_TIMEOUT_MS` (optional) — Kill runs older than this in milliseconds (default: `14400000` = 4 hours)

**Stale run detection:**
Before accepting a trigger, the server checks if tracked processes are still alive (`kill -0`). Dead processes are reaped automatically. Runs exceeding `RUN_TIMEOUT_MS` are force-killed to free the slot.

**Output streaming:**
The `/trigger` endpoint returns a **streaming `text/plain` response** — the script's stdout/stderr are piped back as chunked output in real-time. This serves two critical purposes:
1. **Keeps the Sprite VM alive** — Sprite pauses VMs with no active HTTP requests. The long-lived streaming response counts as an active request for the entire duration of the cycle.
2. **Gives visibility** — GitHub Actions logs show the full cycle output in real-time.

A heartbeat line (`[heartbeat] Run #N active (Xs elapsed)`) is emitted every 15 seconds during silent periods to prevent proxy idle timeouts. If the client disconnects mid-stream, the script keeps running — output continues to drain to the server console.

**Bun idle timeout:** The server calls `server.timeout(req, 0)` on streaming requests to fully disable Bun's per-connection idle timeout (which defaults to 10 seconds and would otherwise kill the connection during silent periods like Claude thinking).

**Endpoints:**
- `GET /health` → `{"status":"ok","running":N,"max":N,"timeoutSec":N,"runs":[...]}` (no auth, shows per-run pid/age)
- `POST /trigger` → validates `Authorization: Bearer <secret>`, reaps stale runs, then streams script output back

**Responses:**
- `200` — Streaming `text/plain` response with script output (success)
- `400` — `{"error":"issue must be a positive integer"}` if issue param is invalid
- `401` — `{"error":"unauthorized"}` if bearer token is wrong
- `409` — `{"error":"run for this issue already in progress"}` if duplicate issue trigger
- `429` — `{"error":"max concurrent runs reached","oldestAgeSec":N}` if at limit
- `503` — `{"error":"server is shutting down"}` during graceful shutdown

## Step 2: Generate a trigger secret

```bash
openssl rand -hex 32
```

Save this — you'll use it in Steps 3 and 5.

## Step 3: Create the wrapper script

Create a **gitignored** wrapper script that sets env vars and launches the server.

Create `start-<service-name>.sh` in the skill directory:

```bash
#!/bin/bash
export TRIGGER_SECRET="<secret-from-step-2>"
export TARGET_SCRIPT="/home/sprite/spawn/.claude/skills/setup-agent-team/<target-script>.sh"
export REPO_ROOT="/home/sprite/spawn"
exec bun run /home/sprite/spawn/.claude/skills/setup-agent-team/trigger-server.ts
```

Make it executable:

```bash
chmod +x /home/sprite/spawn/.claude/skills/setup-agent-team/start-<service-name>.sh
```

**IMPORTANT:** Verify that `.gitignore` includes wrapper scripts:

```
.claude/skills/setup-agent-team/start-*.sh
```

Wrapper scripts contain secrets and MUST NOT be committed.

## Step 4: Create the Sprite service

Register the trigger server as a Sprite service with HTTP port forwarding:

```bash
sprite-env services create <service-name> \
  --cmd bash --args /home/sprite/spawn/.claude/skills/setup-agent-team/start-<service-name>.sh \
  --http-port 8080 --dir /home/sprite/spawn/.claude/skills/setup-agent-team
```

**Key flags:**
- `--http-port 8080` routes incoming HTTP requests to port 8080 AND auto-starts the service when the Sprite wakes from pause
- `--dir` sets the working directory
- Only ONE service per Sprite can have `--http-port`

### Verify the service

```bash
# Check it's running
sprite-env services list

# Test health endpoint
curl -sf http://localhost:8080/health
# Expected: {"status":"ok"}

# Test auth rejection
curl -sf -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/trigger
# Expected: 401

# Test valid trigger
curl -sf -X POST "http://localhost:8080/trigger?reason=test" \
  -H "Authorization: Bearer <secret-from-step-2>"
# Expected: {"triggered":true,"reason":"test","running":1,"max":3}
```

### Service management commands

```bash
sprite-env services list                       # List all services
sprite-env services stop <service-name>        # Stop
sprite-env services start <service-name>       # Start
sprite-env services delete <service-name>      # Delete entirely
```

## Step 5: Set the Sprite URL to public

The Sprite URL must be publicly accessible so GitHub Actions can reach it. Use the Sprite API to set `url_settings.auth` to `"public"`:

```bash
curl -X PUT \
  -H "Authorization: Bearer $SPRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url_settings": {"auth": "public"}}' \
  "https://api.sprites.dev/v1/sprites/$SPRITE_NAME"
```

**How to get the Sprite name and URL:**

```bash
# Get sprite info (requires SPRITE_TOKEN env var)
# The sprite name and URL are shown when you create the Sprite, or via:
curl -s -H "Authorization: Bearer $SPRITE_TOKEN" \
  "https://api.sprites.dev/v1/sprites" | jq '.[] | {name, url}'
```

If `SPRITE_TOKEN` is not set locally, ask the user to provide it or set it as an env var.

**IMPORTANT:** Setting auth to "public" means anyone with the URL can reach the server. This is safe because the trigger server requires a `TRIGGER_SECRET` bearer token — unauthorized requests get a 401.

## Step 6: Create the GitHub Actions workflow

Create `.github/workflows/<service-name>.yml`:

```yaml
name: Trigger <Service Name>

on:
  schedule:
    - cron: '*/30 * * * *'   # Every 30 minutes (adjust as needed)
  issues:
    types: [opened, reopened]
  workflow_dispatch:            # Always include for manual testing

concurrency:
  group: <service-name>-sprite-trigger
  cancel-in-progress: false

jobs:
  trigger:
    runs-on: ubuntu-latest
    timeout-minutes: 90          # Must exceed longest expected cycle
    steps:
      - name: Trigger and stream <service-name> cycle
        env:
          SPRITE_URL: ${{ secrets.<SERVICE_NAME>_SPRITE_URL }}
          TRIGGER_SECRET: ${{ secrets.<SERVICE_NAME>_TRIGGER_SECRET }}
        run: |
          set +e
          # --http1.1: avoid HTTP/2 stream errors on long-lived responses
          # --fail-with-body: exit 22 on HTTP errors but still print the body
          # -N: no output buffering (stream chunks in real-time)
          # --max-time: hard cap matching the Sprite's cycle timeout + grace
          curl -sSN --http1.1 --fail-with-body --max-time 5400 -X POST \
            "${SPRITE_URL}/trigger?reason=${{ github.event_name }}" \
            -H "Authorization: Bearer ${TRIGGER_SECRET}"
          CURL_EXIT=$?
          set -e

          if [ "$CURL_EXIT" -eq 0 ]; then
            echo ""
            echo "=== Cycle completed ==="
          elif [ "$CURL_EXIT" -eq 22 ]; then
            # HTTP error — body was already printed above (429, 409, etc.)
            echo ""
            echo "=== Trigger returned HTTP error (see output above) ==="
          else
            echo ""
            echo "=== curl failed (exit=$CURL_EXIT) ==="
            exit 1
          fi
```

**Important curl flags for streaming:**
- `--http1.1` — **Required.** HTTP/2 has strict stream lifecycle management that kills long-lived chunked responses with `error 92: INTERNAL_ERROR`.
- `-N` — Disables curl's output buffering so chunks appear in the GH Actions log in real-time.
- `--fail-with-body` — Returns exit code 22 on HTTP errors (429/409/401) while still printing the JSON response body for debugging.
- `--max-time 5400` — Hard cap (90 min) as a safety net. Should exceed your longest expected cycle.
- `timeout-minutes: 90` — The GH Actions job timeout. Must match or exceed `--max-time`.

**Cron examples:**
- `'*/30 * * * *'` — every 30 minutes
- `'0 */2 * * *'` — every 2 hours
- `'0 */6 * * *'` — every 6 hours
- `'0 0 * * *'`   — daily at midnight

## Step 7: Set GitHub Actions secrets

Set two secrets per service. Use **namespaced** secret names to avoid collisions:

```bash
# Set the Sprite's public URL
printf '<sprite-url>' | gh secret set <SERVICE_NAME>_SPRITE_URL --repo <owner>/<repo>
# Example: printf 'https://my-sprite-abc1.sprites.app' | gh secret set DISCOVERY_SPRITE_URL --repo OpenRouterTeam/spawn

# Set the trigger secret (from Step 2)
printf '<secret-from-step-2>' | gh secret set <SERVICE_NAME>_TRIGGER_SECRET --repo <owner>/<repo>
# Example: printf '61e6...' | gh secret set DISCOVERY_TRIGGER_SECRET --repo OpenRouterTeam/spawn
```

**Secret naming convention:**

| Secret | Example | Purpose |
|--------|---------|---------|
| `<SERVICE>_SPRITE_URL` | `DISCOVERY_SPRITE_URL` | Public URL of the Sprite |
| `<SERVICE>_TRIGGER_SECRET` | `DISCOVERY_TRIGGER_SECRET` | Bearer token for the trigger server |

## Step 8: Tune RUN_TIMEOUT_MS

`RUN_TIMEOUT_MS` controls how long a run can execute before the trigger server force-kills it and frees the slot. **Start high, then tune down based on real data.**

### Recommended approach

1. **Start with a high timeout (6-12 hours).** You don't know how long cycles take yet. A too-short timeout kills legitimate runs mid-work, leaving orphaned branches, half-merged PRs, and dirty worktrees.

2. **Run several cycles and collect data.** Check the trigger server logs for actual run durations:

```bash
# Look for "finished" lines with duration
cat /.sprite/logs/services/<service-name>.log | grep 'finished'
```

3. **Set the timeout to 2x your longest observed cycle.** For example, if cycles take 30-90 minutes, set `RUN_TIMEOUT_MS` to `10800000` (3 hours). This gives headroom for slow cycles without letting truly hung processes block the slot forever.

4. **Re-evaluate after changes.** Adding more agents to a team, increasing the scope of work, or hitting API rate limits can all increase cycle time. Check logs periodically.

### Current values (based on observed data)

| Service | Observed cycle time | RUN_TIMEOUT_MS | Rationale |
|---------|-------------------|----------------|-----------|
| Discovery (discovery.sh) | 15 min (gaps), 1-2h+ (discovery) | `14400000` (4h) | Discovery cycles are open-ended; gap fills are fast |
| Refactor (refactor.sh) | TBD | `14400000` (4h) | Start high, tune after data |

To override, add to the wrapper script:

```bash
export RUN_TIMEOUT_MS=14400000   # 4 hours
```

Or set it to a very high value initially:

```bash
export RUN_TIMEOUT_MS=43200000   # 12 hours (safe starting point)
```

## Step 9: Ensure the target script is single-cycle

The target script (e.g., `refactor.sh`, `discovery.sh`) MUST:

1. **Run a single cycle and exit** — no `while true` loops
2. **Sync with origin before work** — `git fetch origin main && git pull origin main`
3. **Exit cleanly** — so the trigger server marks it as "not running" and accepts the next trigger

If converting from a looping script, remove the `while true` / `sleep` and keep only the body of one iteration.

**Included scripts in this skill directory:**
- `discovery.sh` — Continuous discovery loop for spawn (already single-cycle ready)
- `refactor.sh` — Refactoring team service (already single-cycle ready)

## Git Conventions for Agent Team Scripts

All agent team scripts (`discovery.sh`, `refactor.sh`, and any future scripts) MUST instruct their agents to follow these conventions:

### 1. Always pull main before creating worktrees

Agents MUST fetch and pull the latest main before starting any branch work:

```bash
git fetch origin main
git pull origin main
```

### 2. Use git worktrees for all branch work

When multiple agents work in parallel, they MUST use worktrees instead of `git checkout -b` to avoid clobbering each other's uncommitted changes:

```bash
# Fetch latest main first
git fetch origin main

# Create worktree from latest origin/main
git worktree add /tmp/spawn-worktrees/BRANCH-NAME -b BRANCH-NAME origin/main

# Work inside the worktree
cd /tmp/spawn-worktrees/BRANCH-NAME
# ... make changes ...

# Commit, push, create PR, merge
git push -u origin BRANCH-NAME
gh pr create --title "..." --body "...

-- TEAM-NAME/AGENT-NAME"
gh pr merge --squash --delete-branch

# Clean up
git worktree remove /tmp/spawn-worktrees/BRANCH-NAME
```

### 3. Include Agent markers in commits

Every agent commit MUST include an `Agent:` trailer identifying which agent authored it:

```
feat: Add RunPod cloud provider

Agent: cloud-scout
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

### 4. Clean up worktrees at end of cycle

The team lead or cleanup function must prune stale worktrees:

```bash
git worktree prune
rm -rf /tmp/spawn-worktrees
```

### 5. Comment sign-off for dedup

Every comment posted by an agent on issues or PRs MUST end with a sign-off line in this format:

```
-- team/agent-name
```

**Format:** `-- <team-name>/<agent-name>` using double-hyphen (`--`), not emdash.

**Examples:**
```
-- security/triage
-- security/pr-reviewer
-- security/issue-checker
-- security/scan
-- refactor/community-coordinator
-- refactor/pr-maintainer
-- discovery/issue-responder
-- discovery/cloud-scout
-- qa/cycle
```

**Why:** Agents run on schedules (every 15-30 min). Without sign-offs, the same issue gets re-triaged and re-commented every cycle. The sign-off lets each agent grep for its own prior comments and skip duplicates:

```bash
# Check if this agent already commented on this issue
gh issue view NUMBER --json comments --jq '.comments[].body' | grep -q '-- security/triage'
```

**Rules:**
- Use `--` (double hyphen), never `—` (emdash) — emdash causes encoding issues in shell strings
- The team name matches the script: `security.sh` → `security`, `refactor.sh` → `refactor`, `discovery.sh` → `discovery`, `qa-cycle.sh` → `qa`
- The agent name matches the teammate name defined in the prompt (e.g., `pr-reviewer`, `community-coordinator`, `issue-responder`)
- Sign-off goes on its own line at the very end of the comment body
- For PR review bodies, wrap in italics: `*-- security/pr-reviewer*`

These conventions are already embedded in the prompts of `discovery.sh`, `refactor.sh`, `security.sh`, and `qa-cycle.sh`. When adding new service scripts, copy the same patterns.

## Step 10: Commit and push

Commit the workflow file and .gitignore changes (but NOT the wrapper script):

```bash
git add .github/workflows/<service-name>.yml .gitignore
git commit -m "feat: Add GitHub Actions trigger for <service-name>"
git push origin main
```

## Step 11: Test end-to-end

```bash
# Trigger manually via GitHub Actions
gh workflow run <service-name>.yml --repo <owner>/<repo>

# Watch the run
gh run list --repo <owner>/<repo> --workflow <service-name>.yml --limit 1

# Check run logs
gh run view <run-id> --repo <owner>/<repo> --log
```

Verify the Sprite wakes, the trigger server accepts the request, and the target script runs.

## Multiple Services on Different Sprites

Each Sprite gets its own:
- `start-<service-name>.sh` wrapper with its own `TRIGGER_SECRET` and `TARGET_SCRIPT`
- GitHub Actions workflow file
- Pair of GitHub secrets (`<SERVICE>_SPRITE_URL` + `<SERVICE>_TRIGGER_SECRET`)

The `trigger-server.ts` file is **shared** — same code runs on every Sprite, configured only by env vars.

## Adding New Service Scripts

To add a new automation script (beyond discovery.sh and refactor.sh):

1. Create the script in `/home/sprite/spawn/.claude/skills/setup-agent-team/<script-name>.sh`
2. Make it executable: `chmod +x <script-name>.sh`
3. Ensure it follows the single-cycle pattern (sync with origin, run once, exit)
4. Create a corresponding `start-<script-name>.sh` wrapper with the appropriate env vars
5. Follow the setup steps above to register the service and create the GitHub Actions workflow

## Sprite Lifecycle & Keep-Alive

**Critical:** Sprite VMs pause when there is no active HTTP request being serviced through the proxy AND no detachable session generating output. This means:

- **Localhost requests do NOT count.** `curl http://localhost:8080/health` bypasses the Sprite proxy entirely and will NOT prevent the VM from pausing.
- **The streaming response IS the keep-alive.** The trigger server streams script output back as a long-lived HTTP response. As long as GH Actions holds the curl connection open, the Sprite sees an active inbound request and stays alive.
- **Heartbeats prevent proxy idle timeouts.** The server emits a `[heartbeat]` line every 15 seconds during silent periods. This keeps intermediate proxies from closing the connection during long silences (e.g., while Claude is thinking).
- **Do NOT add separate keep-alive loops.** The streaming architecture handles this naturally. Adding synthetic pings or background loops is unnecessary and was proven ineffective.

### Bun `idleTimeout` Gotcha

Bun's HTTP server has a default `idleTimeout` of **10 seconds** — it will close connections with no data flowing after 10s. For streaming responses that may be silent for minutes (Claude thinking, waiting for API responses), you MUST disable it:

```ts
// In the fetch handler, before returning the streaming response:
server.timeout(req, 0); // 0 = disable idle timeout for this request
```

The `server.timeout(req, seconds)` API is per-request. Setting `idleTimeout` globally in `Bun.serve()` options has a max of 255 seconds, which is insufficient for long cycles. Always use `server.timeout(req, 0)` for streaming endpoints.

### HTTP/1.1 Required for Streaming

HTTP/2's stream multiplexing does not handle long-lived chunked responses well. curl will fail with `error 92: HTTP/2 stream was not closed cleanly: INTERNAL_ERROR`. Always use `--http1.1` in the curl command.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Service won't start | Check `sprite-env services list` — is another service using `--http-port 8080`? |
| 401 on trigger | Verify `TRIGGER_SECRET` matches between wrapper script and GitHub secret |
| curl exits with code 22 | The sprite URL may require auth — run Step 5 to set `auth: "public"` |
| curl exits with code 92 | HTTP/2 stream error — add `--http1.1` flag to curl |
| curl exits with code 18 | Connection closed prematurely — ensure `server.timeout(req, 0)` is set for streaming requests in trigger-server.ts |
| Sprite pauses mid-cycle | The streaming connection dropped. Check that GH Actions `timeout-minutes` exceeds cycle length and curl uses `--http1.1 -N` flags |
| Script runs but nothing happens | Check the target script works standalone: `bash /path/to/script.sh` |
| Sprite doesn't wake | Verify `<SERVICE>_SPRITE_URL` secret matches the Sprite's public URL |
| `{"error":"max concurrent runs reached"}` | Max concurrent limit reached (default 1) — wait for runs to finish or increase `MAX_CONCURRENT` env var in wrapper script |
| env vars not passed | Use the wrapper script pattern (not `--env` flag with commas in values) |
| GitHub Actions secret is empty | Check `gh secret list --repo <owner>/<repo>` and re-set with `printf` (not `echo`, to avoid trailing newline) |

## Current Deployed Services

| Workflow | Sprite | Service Name | Secrets |
|----------|--------|-------------|---------|
| `discovery.yml` (Trigger Discovery) | `lab-spawn-discovery` | `discovery-trigger` | `DISCOVERY_SPRITE_URL`, `DISCOVERY_TRIGGER_SECRET` |
| `refactor.yml` (Trigger Refactor) | `lab-spawn-foundations` | `refactor` | `REFACTOR_SPRITE_URL`, `REFACTOR_TRIGGER_SECRET` |
