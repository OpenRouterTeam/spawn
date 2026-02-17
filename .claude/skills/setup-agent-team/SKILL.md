---
name: setup-agent-team
description: Set up the Bun trigger server on a VM and configure GitHub Actions to trigger it on a schedule, on events, or manually.
disable-model-invocation: true
argument-hint: "[service-name] [target-script-path]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Setup Trigger Service

Set up a **Bun-based HTTP trigger server** on a VM and configure a **GitHub Actions workflow** to trigger it on a cron schedule, GitHub events, or manual dispatch.

The user wants to set up a trigger service for: **$ARGUMENTS**

## CRITICAL: Repository Path — Ask the User

**NEVER guess the repository path. NEVER invent home directories (e.g., `/home/claude-runner`). ASK the user where the repo lives.**

There are two common environments:

| Environment | Home dir | Typical repo path |
|---|---|---|
| **Sprite VM** (Fly.io managed) | `/home/sprite/` | `/home/sprite/spawn` |
| **Normal VM** (bare metal, cloud) | `/root/` | `/root/spawn` |

### How to determine the path

1. Run `pwd` and check the current working directory
2. If unclear, **ask the user** where the spawn repo is checked out
3. Use that path consistently for ALL configuration: systemd services, wrapper scripts, PATH variables

### Rules

- **NEVER** create new user accounts or home directories for the service
- **NEVER** assume a path like `/home/claude-runner/` — that doesn't exist
- All systemd services, wrapper scripts, and PATH variables MUST use the **same base path** as the repo checkout
- The wrapper scripts (e.g., `start-security.sh`) MUST live inside the repo at `{REPO_ROOT}/.claude/skills/setup-agent-team/`

### Examples (for a repo at `/root/spawn`)

- ✅ `WorkingDirectory=/root/spawn/.claude/skills/setup-agent-team`
- ✅ `ExecStart=/bin/bash /root/spawn/.claude/skills/setup-agent-team/start-security.sh`
- ✅ `Environment="PATH=/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin"`
- ❌ `WorkingDirectory=/home/claude-runner/spawn/...` (invented path)
- ❌ `Environment="PATH=/home/claude-runner/.bun/bin:..."` (invented path)

## Overview

This skill sets up a trigger server that GitHub Actions can call to run a script:

```
GitHub Actions (cron / events / manual)
  -> curl POST $SERVICE_URL/trigger (with Bearer token)
    -> trigger-server.ts validates Bearer token
      -> target script runs (single cycle, then exits)
```

**How it works:**
- The trigger server listens on port 8080
- A `TRIGGER_SECRET` bearer token protects the `/trigger` endpoint from unauthorized access
- The service URL + trigger secret are stored as GitHub Actions secrets

## Prerequisites

- `bun` is installed
- `gh` CLI is installed and authenticated
- Repository has write access for setting secrets

## Step 1: Verify trigger-server.ts

The trigger server lives at:
`$REPO_ROOT/.claude/skills/setup-agent-team/trigger-server.ts`

It reads env vars:
- `TRIGGER_SECRET` (required) — Bearer token for authenticating requests
- `TARGET_SCRIPT` (required) — Absolute path to the script to run on trigger
- `REPO_ROOT` (optional) — Working directory for the script (defaults to script's parent dir)
- `MAX_CONCURRENT` (optional) — Max parallel runs (default: `1`)
- `RUN_TIMEOUT_MS` (optional) — Kill runs older than this in milliseconds (default: `14400000` = 4 hours)

**Stale run detection:**
Before accepting a trigger, the server checks if tracked processes are still alive (`kill -0`). Dead processes are reaped automatically. Runs exceeding `RUN_TIMEOUT_MS` are force-killed to free the slot.

**Output streaming:**
The `/trigger` endpoint returns a **streaming `text/plain` response** — the script's stdout/stderr are piped back as chunked output in real-time. This gives visibility — GitHub Actions logs show the full cycle output in real-time.

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

Create `start-<service-name>.sh` in `{REPO_ROOT}/.claude/skills/setup-agent-team/`:

```bash
#!/bin/bash
# Wrapper script — sets env vars and launches the trigger server.
# CRITICAL: SCRIPT_DIR must match the actual repo path on this machine.
# On a Sprite VM this is /home/sprite/spawn, on a normal VM it's /root/spawn.
SCRIPT_DIR="<REPO_ROOT>/.claude/skills/setup-agent-team"
export TRIGGER_SECRET="<secret-from-step-2>"
export TARGET_SCRIPT="${SCRIPT_DIR}/<target-script>.sh"
export REPO_ROOT="<REPO_ROOT>"
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
export MAX_CONCURRENT=5
export RUN_TIMEOUT_MS=7200000
exec bun run "${SCRIPT_DIR}/trigger-server.ts"
```

Replace `<REPO_ROOT>` with the actual path (e.g., `/root/spawn` or `/home/sprite/spawn`).

Make it executable:

```bash
chmod +x .claude/skills/setup-agent-team/start-<service-name>.sh
```

**IMPORTANT:** Verify that `.gitignore` includes wrapper scripts:

```
.claude/skills/setup-agent-team/start-*.sh
```

Wrapper scripts contain secrets and MUST NOT be committed.

## Step 4: Create the service

Choose the service management approach based on your environment:

### Option A: systemd (recommended)

Create a systemd unit file at `/etc/systemd/system/<service-name>-trigger.service`.

**CRITICAL: Replace `<REPO_ROOT>` and `<HOME>` with the actual paths. Ask the user if unsure.**

| Environment | `<REPO_ROOT>` | `<HOME>` | User/Group |
|---|---|---|---|
| Sprite VM | `/home/sprite/spawn` | `/home/sprite` | `sprite` / `sprite` |
| Normal VM | `/root/spawn` | `/root` | `root` / `root` |

```ini
[Unit]
Description=<Service Name> Trigger Server
After=network.target

[Service]
Type=simple
User=<user>
Group=<group>
WorkingDirectory=<REPO_ROOT>/.claude/skills/setup-agent-team
ExecStart=/bin/bash <REPO_ROOT>/.claude/skills/setup-agent-team/start-<service-name>.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Environment
Environment="IS_SANDBOX=1"
Environment="PATH=<HOME>/.bun/bin:<HOME>/.local/bin:<HOME>/.claude/local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="HOME=<HOME>"

[Install]
WantedBy=multi-user.target
```

**Note:** The wrapper script (`start-<service-name>.sh`) sets the actual env vars (`TRIGGER_SECRET`, `TARGET_SCRIPT`, etc.). The systemd service just executes the wrapper.

Enable and start:

```bash
systemctl daemon-reload
systemctl enable spawn-<service-name>
systemctl start spawn-<service-name>
```

**Service management:**

```bash
systemctl status spawn-<service-name>          # Check status
journalctl -u spawn-<service-name> -f          # Tail logs
systemctl restart spawn-<service-name>         # Restart
systemctl stop spawn-<service-name>            # Stop
```

### Verify the service

```bash
# Test health endpoint
curl -sf http://localhost:8080/health
# Expected: {"status":"ok"}

# Test auth rejection
curl -sf -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/trigger
# Expected: 401

# Test valid trigger
curl -sf -X POST "http://localhost:8080/trigger?reason=test" \
  -H "Authorization: Bearer <secret-from-step-2>"
# Expected: streaming output from the target script
```

## Step 5: Create the GitHub Actions workflow

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
  group: <service-name>-trigger
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
          # --max-time: hard cap matching the cycle timeout + grace
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

## Step 5.5: Determine the Service URL

Before setting GitHub secrets, you need to know the public URL where this service can be accessed. The approach depends on your VM type:

### Option A: Sprite/Fly.io VM

Sprite VMs have a public URL assigned automatically. Get it with:

```bash
flyctl status --json | jq -r '.Hostname'
# Example output: my-sprite-abc1.sprites.app
```

The service URL will be: `https://my-sprite-abc1.sprites.app`

### Option B: Hetzner or other cloud VM (with public IP)

For VMs with a static public IP, use the IP directly:

```bash
curl -s https://api.ipify.org
# Example output: 203.0.113.45
```

The service URL will be: `http://YOUR_IP:8080`

**Important:** Ensure port 8080 is open in your firewall/security group settings.

### Option C: Custom domain or reverse proxy

If you've set up a custom domain or reverse proxy (e.g., nginx with SSL):

The service URL will be: `https://your-custom-domain.com`

Make sure the domain/proxy forwards requests to `localhost:8080`.

## Step 6: Set GitHub Actions secrets

**Cron examples:**
- `'*/30 * * * *'` — every 30 minutes
- `'0 */2 * * * *'` — every 2 hours
- `'0 */6 * * *'` — every 6 hours
- `'0 0 * * *'`   — daily at midnight

Set two secrets per service. Use **namespaced** secret names to avoid collisions:

```bash
# Set the service's public URL (from Step 5.5)
printf '<service-url>' | gh secret set <SERVICE_NAME>_SPRITE_URL --repo <owner>/<repo>

# Examples:
# Sprite VM: printf 'https://my-sprite-abc1.sprites.app' | gh secret set DISCOVERY_SPRITE_URL --repo OpenRouterTeam/spawn
# Hetzner/IP: printf 'http://YOUR_IP:8080' | gh secret set SECURITY_SPRITE_URL --repo OpenRouterTeam/spawn

# Set the trigger secret (from Step 2)
printf '<secret-from-step-2>' | gh secret set <SERVICE_NAME>_TRIGGER_SECRET --repo <owner>/<repo>
# Example: printf '61e6...' | gh secret set DISCOVERY_TRIGGER_SECRET --repo OpenRouterTeam/spawn
```

**Secret naming convention:**

| Secret | Example | Purpose |
|--------|---------|---------|
| `<SERVICE>_SPRITE_URL` | `DISCOVERY_SPRITE_URL` | Public URL of the service |
| `<SERVICE>_TRIGGER_SECRET` | `DISCOVERY_TRIGGER_SECRET` | Bearer token for the trigger server |

## Step 7: Tune RUN_TIMEOUT_MS

`RUN_TIMEOUT_MS` controls how long a run can execute before the trigger server force-kills it and frees the slot. **Start high, then tune down based on real data.**

### Recommended approach

1. **Start with a high timeout (6-12 hours).** You don't know how long cycles take yet. A too-short timeout kills legitimate runs mid-work, leaving orphaned branches, half-merged PRs, and dirty worktrees.

2. **Run several cycles and collect data.** Check the trigger server logs for actual run durations:

```bash
# Look for "finished" lines with duration
grep 'finished' /var/log/spawn-<service-name>.log
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

## Step 8: Ensure the target script is single-cycle

The target script (e.g., `refactor.sh`, `discovery.sh`) MUST:

1. **Run a single cycle and exit** — no `while true` loops
2. **Sync with origin before work** — `git fetch origin main && git pull origin main`
3. **Exit cleanly** — so the trigger server marks it as "not running" and accepts the next trigger

If converting from a looping script, remove the `while true` / `sleep` and keep only the body of one iteration.

**Included scripts in this skill directory:**
- `discovery.sh` — Continuous discovery loop for spawn (already single-cycle ready)
- `refactor.sh` — Refactoring team service (already single-cycle ready)

## Agent Teams (ref: https://code.claude.com/docs/en/agent-teams)

**Agent teams are experimental and disabled by default.** Every service script and wrapper MUST export:

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

This can also be set in `settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### .spawnrc persistence

On spawn VMs, `~/.spawnrc` is sourced by every agent launch command. Service scripts automatically inject the flag into `.spawnrc` if it exists, ensuring all Claude sessions on the VM inherit it:

```bash
if [[ -f "${HOME}/.spawnrc" ]]; then
    grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "${HOME}/.spawnrc" 2>/dev/null || \
        printf '\nexport CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\n' >> "${HOME}/.spawnrc"
fi
```

This is idempotent — it only appends once. All four service scripts (`discovery.sh`, `refactor.sh`, `security.sh`, `qa-cycle.sh`) include this check.

All service scripts use **agent teams**, not subagents. Key differences:

| | Subagents | Agent Teams |
|---|---|---|
| **Communication** | Results return to caller only | Teammates message each other directly |
| **Context** | Shares caller's context | Independent context window |
| **Coordination** | Caller manages all work | Shared task list with self-coordination |

### Team coordination pattern for `claude -p` mode

In `claude -p` (print) mode, the session ends when no tool call is made. The lead must stay alive by always including a tool call. **The correct monitoring loop is:**

```
1. Call TaskList to check task status
2. Process any teammate messages (they arrive automatically as user turns)
3. If tasks still pending, call Bash("sleep 5") to yield, then go back to step 1
4. Once all tasks complete, shutdown teammates and exit
```

**EVERY iteration MUST call TaskList.** Looping on `sleep 5` alone blocks message delivery without checking progress. This is the #1 cause of stuck cycles.

### Spawning teammates correctly

When spawning teammates via the Task tool, **always pass `team_name` and `name`** so they join the team:

```
Task(subagent_type='general-purpose', team_name='my-team', name='reviewer-1', prompt='...')
```

Without `team_name`, agents spawn as subagents that can't use team messaging.

### Prompt completeness

Each teammate gets its own context window and **cannot see other teammates' prompts**. Always include the COMPLETE instructions in every teammate's prompt. Never abbreviate with "follow the same protocol as agent X".

## Git Conventions for Agent Team Scripts

All agent team scripts (`discovery.sh`, `refactor.sh`, and any future scripts) MUST instruct their agents to follow these conventions:

### 1. Always pull main before creating worktrees

Agents MUST fetch and pull the latest main before starting any branch work:

```bash
git fetch origin main
git pull origin main
```

### 2. Use git worktrees for ALL work (mandatory)

**Every agent MUST work in a git worktree — NEVER operate directly in the main repo checkout.** This applies to all work: creating branches, reviewing PRs, running tests, reading code for audits, etc.

When multiple agents work in parallel, they MUST use worktrees instead of `git checkout -b` to avoid clobbering each other's uncommitted changes:

```bash
# Fetch latest main first
git fetch origin main

# Create worktree from latest origin/main
git worktree add /tmp/spawn-worktrees/BRANCH-NAME -b BRANCH-NAME origin/main

# Work inside the worktree
cd /tmp/spawn-worktrees/BRANCH-NAME
# ... make changes, run tests, etc. ...

# Commit, push, create PR
git push -u origin BRANCH-NAME
gh pr create --title "..." --body "...

-- TEAM-NAME/AGENT-NAME"

# Clean up
git worktree remove /tmp/spawn-worktrees/BRANCH-NAME
```

**For PR review/testing** (read-only worktree):
```bash
git worktree add /tmp/spawn-worktrees/pr-NUMBER -b review-pr-NUMBER origin/main
cd /tmp/spawn-worktrees/pr-NUMBER
gh pr checkout NUMBER
# ... run bash -n, bun test, read files ...
cd /path/to/repo
git worktree remove /tmp/spawn-worktrees/pr-NUMBER --force
```

**Why:** The main checkout must stay clean so concurrent agents don't conflict. Worktrees provide isolated working directories for each agent.

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

Verify the trigger server accepts the request and the target script runs.

## Multiple Services on Different VMs

Each VM gets its own:
- `start-<service-name>.sh` wrapper with its own `TRIGGER_SECRET` and `TARGET_SCRIPT`
- GitHub Actions workflow file
- Pair of GitHub secrets (`<SERVICE>_SPRITE_URL` + `<SERVICE>_TRIGGER_SECRET`)

The `trigger-server.ts` file is **shared** — same code runs on every VM, configured only by env vars.

## Adding New Service Scripts

To add a new automation script (beyond discovery.sh and refactor.sh):

1. Create the script in `$REPO_ROOT/.claude/skills/setup-agent-team/<script-name>.sh`
2. Make it executable: `chmod +x <script-name>.sh`
3. Ensure it follows the single-cycle pattern (sync with origin, run once, exit)
4. Create a corresponding `start-<script-name>.sh` wrapper with the appropriate env vars
5. Follow the setup steps above to register the service and create the GitHub Actions workflow

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
| Service won't start | Check if another service is using port 8080 |
| 401 on trigger | Verify `TRIGGER_SECRET` matches between wrapper script and GitHub secret |
| curl exits with code 22 | The service URL may require auth — ensure it is publicly accessible |
| curl exits with code 92 | HTTP/2 stream error — add `--http1.1` flag to curl |
| curl exits with code 18 | Connection closed prematurely — ensure `server.timeout(req, 0)` is set for streaming requests in trigger-server.ts |
| VM becomes unreachable mid-cycle | The streaming connection dropped. Check that GH Actions `timeout-minutes` exceeds cycle length and curl uses `--http1.1 -N` flags |
| Script runs but nothing happens | Check the target script works standalone: `bash /path/to/script.sh` |
| VM doesn't respond | Verify `<SERVICE>_SPRITE_URL` secret matches the service's public URL |
| `{"error":"max concurrent runs reached"}` | Max concurrent limit reached (default 1) — wait for runs to finish or increase `MAX_CONCURRENT` env var in wrapper script |
| env vars not passed | Use the wrapper script pattern (not `--env` flag with commas in values) |
| GitHub Actions secret is empty | Check `gh secret list --repo <owner>/<repo>` and re-set with `printf` (not `echo`, to avoid trailing newline) |
| systemd service won't start | Check `journalctl -u spawn-<name> -n 50` — common issues: port in use (EADDRINUSE), wrong PATH (bun/claude not found), permission denied |
| systemd service keeps restarting | Check exit code in `systemctl status` — if exit 1, check journal logs. If EADDRINUSE, run `fuser -k 8080/tcp` first |

## Current Deployed Services

| Workflow | Host | Service Type | Service Name | Secrets |
|----------|------|-------------|-------------|---------|
| `discovery.yml` (Trigger Discovery) | VM | systemd | `discovery-trigger` | `DISCOVERY_SPRITE_URL`, `DISCOVERY_TRIGGER_SECRET` |
| `refactor.yml` (Trigger Refactor) | VM | systemd | `refactor` | `REFACTOR_SPRITE_URL`, `REFACTOR_TRIGGER_SECRET` |
| `security.yml` (Trigger Security) | VM | systemd | `spawn-security` | `SECURITY_SPRITE_URL`, `SECURITY_TRIGGER_SECRET` |
