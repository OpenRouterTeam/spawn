---
name: setup-trigger-service
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
`/home/sprite/spawn/.claude/skills/setup-trigger-service/trigger-server.ts`

It reads two required env vars:
- `TRIGGER_SECRET` — Bearer token for authenticating requests
- `TARGET_SCRIPT` — Absolute path to the script to run on trigger

**Endpoints:**
- `GET /health` → `{"status":"ok"}` (no auth, for health checks)
- `POST /trigger` → validates `Authorization: Bearer <secret>`, runs target script in background

**Responses:**
- `200` — `{"triggered":true,"reason":"...","running":N,"max":N}` on success
- `401` — `{"error":"unauthorized"}` if bearer token is wrong
- `429` — `{"error":"max concurrent runs reached"}` if at limit (default 3, configurable via `MAX_CONCURRENT` env var)

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
export TARGET_SCRIPT="/home/sprite/spawn/.claude/skills/setup-trigger-service/<target-script>.sh"
exec bun run /home/sprite/spawn/.claude/skills/setup-trigger-service/trigger-server.ts
```

Make it executable:

```bash
chmod +x /home/sprite/spawn/.claude/skills/setup-trigger-service/start-<service-name>.sh
```

**IMPORTANT:** Verify that `.gitignore` includes wrapper scripts:

```
.claude/skills/setup-trigger-service/start-*.sh
```

Wrapper scripts contain secrets and MUST NOT be committed.

## Step 4: Create the Sprite service

Register the trigger server as a Sprite service with HTTP port forwarding:

```bash
sprite-env services create <service-name> \
  --cmd bash --args /home/sprite/spawn/.claude/skills/setup-trigger-service/start-<service-name>.sh \
  --http-port 8080 --dir /home/sprite/spawn/.claude/skills/setup-trigger-service
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
    steps:
      - name: Trigger <service-name> sprite
        env:
          SPRITE_URL: ${{ secrets.<SERVICE_NAME>_SPRITE_URL }}
          TRIGGER_SECRET: ${{ secrets.<SERVICE_NAME>_TRIGGER_SECRET }}
        run: |
          curl -sf -X POST "${SPRITE_URL}/trigger?reason=${{ github.event_name }}" \
            -H "Authorization: Bearer ${TRIGGER_SECRET}"
```

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

## Step 8: Ensure the target script is single-cycle

The target script (e.g., `refactor.sh`, `improve.sh`) MUST:

1. **Run a single cycle and exit** — no `while true` loops
2. **Sync with origin before work** — `git fetch && git reset --hard origin/main`
3. **Exit cleanly** — so the trigger server marks it as "not running" and accepts the next trigger

If converting from a looping script, remove the `while true` / `sleep` and keep only the body of one iteration.

**Included scripts in this skill directory:**
- `improve.sh` — Continuous improvement loop for spawn (already single-cycle ready)
- `refactor.sh` — Refactoring team service (already single-cycle ready)

## Step 9: Commit and push

Commit the workflow file and .gitignore changes (but NOT the wrapper script):

```bash
git add .github/workflows/<service-name>.yml .gitignore
git commit -m "feat: Add GitHub Actions trigger for <service-name>"
git push origin main
```

## Step 10: Test end-to-end

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

To add a new automation script (beyond improve.sh and refactor.sh):

1. Create the script in `/home/sprite/spawn/.claude/skills/setup-trigger-service/<script-name>.sh`
2. Make it executable: `chmod +x <script-name>.sh`
3. Ensure it follows the single-cycle pattern (sync with origin, run once, exit)
4. Create a corresponding `start-<script-name>.sh` wrapper with the appropriate env vars
5. Follow the setup steps above to register the service and create the GitHub Actions workflow

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Service won't start | Check `sprite-env services list` — is another service using `--http-port 8080`? |
| 401 on trigger | Verify `TRIGGER_SECRET` matches between wrapper script and GitHub secret |
| curl exits with code 22 | The sprite URL may require auth — run Step 5 to set `auth: "public"` |
| Script runs but nothing happens | Check the target script works standalone: `bash /path/to/script.sh` |
| Sprite doesn't wake | Verify `<SERVICE>_SPRITE_URL` secret matches the Sprite's public URL |
| `{"error":"max concurrent runs reached"}` | Max concurrent limit reached (default 3) — wait for runs to finish or increase `MAX_CONCURRENT` env var in wrapper script |
| env vars not passed | Use the wrapper script pattern (not `--env` flag with commas in values) |
| GitHub Actions secret is empty | Check `gh secret list --repo <owner>/<repo>` and re-set with `printf` (not `echo`, to avoid trailing newline) |

## Current Deployed Services

| Workflow | Sprite | Service Name | Secrets |
|----------|--------|-------------|---------|
| `improve.yml` (Trigger Discovery) | `lab-spawn-discovery` | `improve-trigger` | `DISCOVERY_SPRITE_URL`, `DISCOVERY_TRIGGER_SECRET` |
| `refactor.yml` (Trigger Refactor) | `lab-spawn-foundations` | `refactor` | `REFACTOR_SPRITE_URL`, `REFACTOR_TRIGGER_SECRET` |
