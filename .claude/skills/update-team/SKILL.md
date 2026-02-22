---
name: update-team
description: Update agent team services with latest configuration from setup-agent-team and restart them
argument-hint: "[service-name] [--check-only]"
allowed-tools: Bash, Read, Edit, Glob, Grep
---

# Update Agent Team Services

Update the trigger server and wrapper scripts with the latest configuration from `.claude/skills/setup-agent-team/SKILL.md`, then restart the services to apply changes.

## Arguments

- `service-name` (optional) — Update only this service (e.g., `discovery`, `refactor`, `security`, `qa`). If omitted, updates all services.
- `--check-only` — Show what would be updated without making changes or restarting services.

**$ARGUMENTS**

## Overview

This skill:
1. Reads the latest setup-agent-team SKILL.md for current best practices
2. Identifies all deployed services by scanning for `start-*.sh` wrappers
3. Updates wrapper scripts with correct env vars and paths
4. Restarts systemd services to apply changes
5. Verifies services are running and healthy

## Step 1: Determine repository path

Detect the current repository path:

```bash
REPO_ROOT="$(cd /root/spawn 2>/dev/null && pwd || cd /home/sprite/spawn 2>/dev/null && pwd)"
echo "Repository root: $REPO_ROOT"
```

Determine home directory:

```bash
if [[ "$REPO_ROOT" == "/root/spawn" ]]; then
    HOME_DIR="/root"
    SERVICE_USER="root"
    SERVICE_GROUP="root"
elif [[ "$REPO_ROOT" == "/home/sprite/spawn" ]]; then
    HOME_DIR="/home/sprite"
    SERVICE_USER="sprite"
    SERVICE_GROUP="sprite"
else
    echo "ERROR: Unknown repository path: $REPO_ROOT"
    exit 1
fi

echo "Home directory: $HOME_DIR"
echo "Service user/group: $SERVICE_USER/$SERVICE_GROUP"
```

## Step 2: Read latest setup-agent-team instructions

Read the SKILL.md to check for:
- Latest env var requirements
- Recommended timeout values
- New mandatory settings
- Path patterns

```bash
cat "$REPO_ROOT/.claude/skills/setup-agent-team/SKILL.md"
```

Key things to extract from SKILL.md:
- Required env vars: `TRIGGER_SECRET`, `TARGET_SCRIPT`, `REPO_ROOT`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `MAX_CONCURRENT`, `RUN_TIMEOUT_MS`
- Recommended `RUN_TIMEOUT_MS` values per service
- Path templates for systemd service files

## Step 3: Identify deployed services

Find all wrapper scripts:

```bash
ls -1 "$REPO_ROOT/.claude/skills/setup-agent-team/start-"*.sh 2>/dev/null | while read -r wrapper; do
    basename "$wrapper" | sed 's/^start-//;s/\.sh$//'
done
```

For each service found, check if it has a corresponding systemd unit:

```bash
systemctl list-units --all --type=service --plain --no-legend | grep -E 'discovery-trigger|refactor|spawn-security|spawn-qa' | awk '{print $1}'
```

Match wrappers to systemd units:
- `start-discovery.sh` → `discovery-trigger.service`
- `start-refactor.sh` → `refactor.service`
- `start-security.sh` → `spawn-security.service`
- `start-qa.sh` → `spawn-qa.service` (if exists)

## Step 4: Check wrapper script compliance

For each wrapper script, verify it has:

### Required env vars

```bash
# Check if wrapper has all required env vars
grep -q 'export TRIGGER_SECRET=' "$wrapper_path" || echo "MISSING: TRIGGER_SECRET"
grep -q 'export TARGET_SCRIPT=' "$wrapper_path" || echo "MISSING: TARGET_SCRIPT"
grep -q 'export REPO_ROOT=' "$wrapper_path" || echo "MISSING: REPO_ROOT"
grep -q 'export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' "$wrapper_path" || echo "MISSING: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
grep -q 'export MAX_CONCURRENT=' "$wrapper_path" || echo "MISSING: MAX_CONCURRENT"
grep -q 'export RUN_TIMEOUT_MS=' "$wrapper_path" || echo "MISSING: RUN_TIMEOUT_MS"
```

### Correct paths

```bash
# Extract SCRIPT_DIR from wrapper
SCRIPT_DIR=$(grep '^SCRIPT_DIR=' "$wrapper_path" | cut -d'"' -f2)

# Verify it matches REPO_ROOT
if [[ "$SCRIPT_DIR" != "$REPO_ROOT/.claude/skills/setup-agent-team" ]]; then
    echo "WARNING: SCRIPT_DIR mismatch"
    echo "  Found: $SCRIPT_DIR"
    echo "  Expected: $REPO_ROOT/.claude/skills/setup-agent-team"
fi
```

### Exec pattern

```bash
# Verify it uses exec bun run
grep -q 'exec bun run "${SCRIPT_DIR}/trigger-server.ts"' "$wrapper_path" || echo "WARNING: Non-standard exec pattern"
```

## Step 5: Check systemd service compliance

For each systemd service file at `/etc/systemd/system/<service-name>.service`:

### Required fields

```bash
# Check critical fields
grep -q "^User=$SERVICE_USER$" "$service_file" || echo "MISSING/WRONG: User"
grep -q "^Group=$SERVICE_GROUP$" "$service_file" || echo "MISSING/WRONG: Group"
grep -q "^WorkingDirectory=$REPO_ROOT/.claude/skills/setup-agent-team$" "$service_file" || echo "MISSING/WRONG: WorkingDirectory"
grep -q "^ExecStart=/bin/bash $REPO_ROOT/.claude/skills/setup-agent-team/start-" "$service_file" || echo "MISSING/WRONG: ExecStart"
```

### Environment variables

```bash
# Check PATH includes correct home directory
grep "^Environment=\"PATH=$HOME_DIR/.bun/bin:$HOME_DIR/.local/bin:" "$service_file" || echo "WARNING: PATH may be incorrect"

# Check HOME is set
grep "^Environment=\"HOME=$HOME_DIR\"$" "$service_file" || echo "MISSING/WRONG: HOME"

# Check IS_SANDBOX
grep -q '^Environment="IS_SANDBOX=1"' "$service_file" || echo "MISSING: IS_SANDBOX"
```

## Step 6: Update wrapper scripts (if needed)

If `--check-only` is NOT passed and issues were found:

For path mismatches, update SCRIPT_DIR:

```bash
# This requires preserving the TRIGGER_SECRET value
# Read current secret
CURRENT_SECRET=$(grep '^export TRIGGER_SECRET=' "$wrapper_path" | cut -d'"' -f2)

# Update SCRIPT_DIR line
sed -i "s|^SCRIPT_DIR=.*|SCRIPT_DIR=\"$REPO_ROOT/.claude/skills/setup-agent-team\"|" "$wrapper_path"

# Update REPO_ROOT line
sed -i "s|^export REPO_ROOT=.*|export REPO_ROOT=\"$REPO_ROOT\"|" "$wrapper_path"
```

For missing env vars, add them:

```bash
# Add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS if missing
if ! grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' "$wrapper_path"; then
    # Insert before exec line
    sed -i '/^exec bun run/i export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1' "$wrapper_path"
fi

# Add MAX_CONCURRENT if missing (default: 5)
if ! grep -q 'MAX_CONCURRENT' "$wrapper_path"; then
    sed -i '/^exec bun run/i export MAX_CONCURRENT=5' "$wrapper_path"
fi

# Add RUN_TIMEOUT_MS if missing (default: 4 hours)
if ! grep -q 'RUN_TIMEOUT_MS' "$wrapper_path"; then
    sed -i '/^exec bun run/i export RUN_TIMEOUT_MS=14400000' "$wrapper_path"
fi
```

## Step 7: Update systemd service files (if needed)

If systemd service files need updates:

**IMPORTANT:** Changes to systemd service files require `sudo` and a daemon-reload.

```bash
# Update User/Group
sudo sed -i "s/^User=.*/User=$SERVICE_USER/" "$service_file"
sudo sed -i "s/^Group=.*/Group=$SERVICE_GROUP/" "$service_file"

# Update WorkingDirectory
sudo sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$REPO_ROOT/.claude/skills/setup-agent-team|" "$service_file"

# Update ExecStart
sudo sed -i "s|^ExecStart=.*|ExecStart=/bin/bash $REPO_ROOT/.claude/skills/setup-agent-team/start-$service_name.sh|" "$service_file"

# Update PATH
sudo sed -i "s|^Environment=\"PATH=.*|Environment=\"PATH=$HOME_DIR/.bun/bin:$HOME_DIR/.local/bin:$HOME_DIR/.claude/local/bin:/usr/local/bin:/usr/bin:/bin\"|" "$service_file"

# Update HOME
sudo sed -i "s|^Environment=\"HOME=.*|Environment=\"HOME=$HOME_DIR\"|" "$service_file"

# Reload systemd
sudo systemctl daemon-reload
```

## Step 8: Restart services

If changes were made (and not `--check-only`):

```bash
# Restart each updated service
sudo systemctl restart "$service_name"

# Wait a moment for startup
sleep 2

# Check status
sudo systemctl status "$service_name" --no-pager
```

## Step 9: Verify health

For each service, test the health endpoint:

```bash
# Test health endpoint (should return 200 OK)
curl -sf http://localhost:8080/health || echo "ERROR: Health check failed for $service_name"

# Expected output: {"status":"ok","running":N,"max":N,...}
```

If health check fails:

```bash
# Check recent logs
sudo journalctl -u "$service_name" -n 20 --no-pager
```

## Step 10: Summary

Print a summary:

```bash
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Update Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Repository: $REPO_ROOT"
echo "Home: $HOME_DIR"
echo "Services checked: $total_services"
echo "Services updated: $updated_count"
echo "Services restarted: $restarted_count"
echo "Services healthy: $healthy_count"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

If all services are healthy:

```
✅ All services are up to date and running
```

If there were issues:

```
⚠️  Some services may need attention - check logs above
```

## Common Issues

| Issue | Fix |
|-------|-----|
| `EADDRINUSE` on restart | Another service already using port 8080 — check with `fuser -k 8080/tcp` |
| Permission denied | Systemd files need sudo: `sudo systemctl restart <service>` |
| Health check fails | Check logs: `sudo journalctl -u <service> -n 50` |
| Wrapper not executable | `chmod +x .claude/skills/setup-agent-team/start-*.sh` |
| PATH incorrect | Update systemd service Environment="PATH=..." to match home dir |
| Service won't start after update | Check `systemctl status <service>` for detailed error |

## Best Practices

- **Always run with `--check-only` first** to see what would change before applying updates
- **Restart services during low-activity periods** to avoid interrupting ongoing cycles
- **Check logs after restart** to ensure services started cleanly
- **Test the trigger endpoint** after restart: `curl -X POST http://localhost:8080/trigger -H "Authorization: Bearer $SECRET"`
- **Never commit wrapper scripts** — they contain secrets and are in .gitignore

## Example Usage

Check all services without making changes:

```bash
claude /update-team --check-only
```

Update a specific service:

```bash
claude /update-team discovery
```

Update all services:

```bash
claude /update-team
```
