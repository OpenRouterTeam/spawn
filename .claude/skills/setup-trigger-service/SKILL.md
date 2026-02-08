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

Sprites pause when idle to save resources. This skill uses the [Sprite start service API](https://docs.sprites.dev/api/v001-rc30/services/#start-service) to wake the Sprite and run a service on demand:

```
GitHub Actions (cron / events / manual)
  -> POST https://api.sprites.dev/v1/sprites/{name}/services/{service}/start
    -> Sprite API wakes the Sprite from pause
      -> Sprite starts the specified service (trigger-server.ts)
        -> trigger-server.ts runs the target script (single cycle, then exits)
          -> Sprite goes idle again until next trigger
```

The trigger server is configured with `--http-port 8080`, which makes the service auto-start when the Sprite receives incoming HTTP traffic.

## Step 1: Ensure trigger-server.ts exists

The trigger server is included in this skill directory at:
`/home/sprite/spawn/.claude/skills/setup-trigger-service/trigger-server.ts`

You can use this file directly, or copy it to your repo if needed. The file contents are:

```typescript
const PORT = 8080;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET ?? "";
const TARGET_SCRIPT = process.env.TARGET_SCRIPT ?? "";

if (!TRIGGER_SECRET) {
  console.error("ERROR: TRIGGER_SECRET env var is required");
  process.exit(1);
}

if (!TARGET_SCRIPT) {
  console.error("ERROR: TARGET_SCRIPT env var is required");
  process.exit(1);
}

let running = false;

async function runScript(reason: string) {
  try {
    console.log(`[trigger] Running ${TARGET_SCRIPT} (reason=${reason})`);
    const proc = Bun.spawn(["bash", TARGET_SCRIPT], {
      cwd: TARGET_SCRIPT.substring(0, TARGET_SCRIPT.lastIndexOf("/")) || ".",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    console.log(`[trigger] ${TARGET_SCRIPT} finished (exit=${proc.exitCode})`);
  } catch (e) {
    console.error(`[trigger] ${TARGET_SCRIPT} failed:`, e);
  } finally {
    running = false;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/trigger") {
      const auth = req.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${TRIGGER_SECRET}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      if (running) {
        return Response.json({ error: "already running" }, { status: 409 });
      }

      running = true;
      const reason = url.searchParams.get("reason") ?? "manual";
      runScript(reason);
      return Response.json({ triggered: true, reason });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`[trigger] Listening on port ${server.port}`);
console.log(`[trigger] TARGET_SCRIPT=${TARGET_SCRIPT}`);
```

**Key behaviors:**
- `GET /health` -> `{"status":"ok"}` (no auth, for health checks)
- `POST /trigger` -> validates `Authorization: Bearer <secret>`, runs target script in background
- Returns `409` if script is already running (prevents overlapping executions)
- Zero npm dependencies — uses only Bun built-ins

## Step 2: Generate a secret

Generate a random secret for this service:

```bash
openssl rand -hex 32
```

Save the output — you'll need it in steps 3 and 5.

## Step 3: Create the wrapper script

Create a **gitignored** wrapper script that sets env vars and launches the server. This file contains secrets and MUST NOT be committed.

Create `start-<service-name>.sh` in the skill directory (e.g., `start-improve.sh`, `start-refactor.sh`):

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

All `start-*.sh` files in the skill directory should be gitignored since they contain secrets.

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
  -H "Authorization: Bearer <secret>"
# Expected: {"triggered":true,"reason":"test"}
```

### Service management commands

```bash
sprite-env services list                       # List all services
sprite-env services stop <service-name>        # Stop
sprite-env services start <service-name>       # Start
sprite-env services restart <service-name>     # Restart
sprite-env services delete <service-name>      # Delete entirely
```

## Step 5: Create the GitHub Actions workflow

Create `.github/workflows/<service-name>.yml`:

```yaml
name: Trigger <Service Name>

on:
  schedule:
    - cron: '0 */2 * * *'    # Every 2 hours (adjust as needed)
  # Add event triggers as needed:
  # issues:
  #   types: [opened, reopened]
  # push:
  #   branches: [main]
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
          SPRITE_TOKEN: ${{ secrets.SPRITE_TOKEN }}
          SPRITE_NAME: ${{ secrets.<SERVICE_NAME>_SPRITE_NAME }}
          SERVICE_NAME: ${{ secrets.<SERVICE_NAME>_SERVICE_NAME }}
        run: |
          curl -sf -X POST "https://api.sprites.dev/v1/sprites/${SPRITE_NAME}/services/${SERVICE_NAME}/start" \
            -H "Authorization: Bearer ${SPRITE_TOKEN}" --max-time 30
```

**Note:** This uses the [Sprite start service API](https://docs.sprites.dev/api/v001-rc30/services/#start-service) which wakes the Sprite and starts the specified service automatically.

**Cron examples:**
- `'0 */2 * * *'` — every 2 hours
- `'0 */6 * * *'` — every 6 hours
- `'0 0 * * *'`   — daily at midnight
- `'*/30 * * * *'` — every 30 minutes

## Step 6: Set GitHub Actions secrets

Set three secrets per Sprite service. Use **namespaced** secret names to avoid collisions:

### 6a. Get the Sprite name and service name

The Sprite name and service name are needed to use the [Sprite start service API](https://docs.sprites.dev/api/v001-rc30/services/#start-service).

```bash
# Get the sprite name (ask user if not available programmatically)
# The sprite name is what you used when creating the Sprite

# Get the service name (from Step 4)
sprite-env services list
# Use the name you registered in Step 4 (e.g., "improve-trigger")
```

### 6b. Set the secrets

```bash
# Set the sprite name (one per Sprite)
gh secret set <SERVICE_NAME>_SPRITE_NAME --repo <owner>/<repo>
# When prompted, enter the sprite name (e.g., "improve-sprite")

# Set the service name (matches the name from Step 4)
gh secret set <SERVICE_NAME>_SERVICE_NAME --repo <owner>/<repo>
# When prompted, enter the service name (e.g., "improve-trigger")

# Set the Sprite API token (shared across all services)
# This should already be set as SPRITE_TOKEN
gh secret set SPRITE_TOKEN --repo <owner>/<repo>
# When prompted, paste your Sprite API token from https://sprites.dev
```

**Secret naming convention:**

| Secret | Example | Purpose |
|--------|---------|---------|
| `SPRITE_TOKEN` | `SPRITE_TOKEN` | Sprite API bearer token (shared across all services) |
| `<SERVICE>_SPRITE_NAME` | `IMPROVE_SPRITE_NAME` | Name of the Sprite running this service |
| `<SERVICE>_SERVICE_NAME` | `IMPROVE_SERVICE_NAME` | Name of the service registered in Step 4 |

## Step 7: Ensure the target script is single-cycle

The target script (e.g., `refactor.sh`, `improve.sh`) MUST:

1. **Run a single cycle and exit** — no `while true` loops
2. **Sync with origin before work** — `git fetch && git reset --hard origin/main`
3. **Exit cleanly** — so the trigger server marks it as "not running" and accepts the next trigger

If converting from a looping script, remove the `while true` / `sleep` and keep only the body of one iteration.

**Included scripts in this skill directory:**
- `improve.sh` — Continuous improvement loop for spawn (already single-cycle ready)
- `refactor.sh` — Refactoring team service (already single-cycle ready)

To create a new service script, add it to `/home/sprite/spawn/.claude/skills/setup-trigger-service/` and follow the same pattern.

## Step 8: Commit and push

Commit the workflow file and .gitignore changes (but NOT the wrapper script):

```bash
git add .github/workflows/<service-name>.yml .gitignore
git commit -m "feat: Add GitHub Actions trigger for <service-name>"
git push origin main
```

Note: The trigger-server.ts and service scripts are already in the skill directory and don't need to be committed again.

## Step 9: Test end-to-end

1. Go to the GitHub Actions tab
2. Select the workflow
3. Click "Run workflow" (workflow_dispatch)
4. Verify the Sprite wakes and runs the target script

## Multiple Services on Different Sprites

Each Sprite gets its own:
- `start-<service-name>.sh` in the skill directory with its own `TRIGGER_SECRET` and `TARGET_SCRIPT`
- GitHub Actions workflow file
- Pair of GitHub secrets (`<SERVICE>_SPRITE_URL` + `<SERVICE>_SPRITE_SECRET`)

The `trigger-server.ts` file is **shared** — same code runs on every Sprite, configured only by env vars.

## Adding New Service Scripts

To add a new automation script (beyond improve.sh and refactor.sh):

1. Create the script in `/home/sprite/spawn/.claude/skills/setup-trigger-service/<script-name>.sh`
2. Make it executable: `chmod +x <script-name>.sh`
3. Ensure it follows the single-cycle pattern (sync with origin, run once, exit)
4. Create a corresponding `start-<script-name>.sh` wrapper with the appropriate env vars
5. Follow the setup steps above to register the service and create the GitHub Actions workflow

## Prerequisites

This skill assumes:
- You are running Claude Code **inside a Sprite VM**
- `sprite-env` commands are available
- `bun` is installed (comes with Sprite by default)
- `gh` CLI is installed and authenticated
- Repository has write access for setting secrets

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Service won't start | Check `sprite-env services list` — is another service using `--http-port 8080`? |
| 401 on API call | Verify `SPRITE_TOKEN` is set correctly in GitHub secrets |
| Script runs but nothing happens | Check the target script works standalone: `bash /path/to/script.sh` |
| Sprite doesn't wake | Verify `<SERVICE>_SPRITE_NAME` and `<SERVICE>_SERVICE_NAME` secrets are correct |
| `{"error":"max concurrent runs reached"}` | Max concurrent limit reached (default 3) — wait for runs to finish or increase MAX_CONCURRENT |
| env vars not passed | Use the wrapper script pattern (not `--env` flag with commas in values) |
| Service not found | Verify the service name matches what you registered in Step 4 with `sprite-env services create` |
