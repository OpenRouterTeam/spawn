---
name: slack-bot
description: Spawnis — Slack bot that pipes threads into Claude Code sessions and streams responses back
disable-model-invocation: true
---

# Spawnis

Slack bot that listens in `#proj-spawn` via Socket Mode. When @mentioned, it collects the full thread, pipes it into a `claude -p` session, and streams Claude Code's responses back to the Slack thread in real-time.

Subsequent @mentions in the same thread resume the same Claude Code session.

## Slack App Setup

### Option A: Create from manifest (recommended)

1. Go to https://api.slack.com/apps
2. Click **Create New App** > **From a manifest**
3. Select your workspace
4. Paste the contents of `slack-manifest.yml` from this directory
5. Click **Create**
6. **Socket Mode**: Settings > Basic Information > scroll to "App-Level Tokens" > **Generate Token and Scopes** > add `connections:write` scope > copy the `xapp-...` token
7. **Install to Workspace**: Features > OAuth & Permissions > Install > copy the `xoxb-...` Bot User OAuth Token
8. **Invite the bot** to the target channel: `/invite @Spawnis`
9. **Get the channel ID**: Right-click channel name > View channel details > copy the ID (starts with `C`)

### Option B: Manual setup

1. Go to https://api.slack.com/apps > **Create New App** > **From scratch**
2. Name it `Spawnis`, select the workspace
3. **Socket Mode**: Settings > Socket Mode > Enable > generate app-level token with `connections:write` scope > save `xapp-...`
4. **Event Subscriptions**: Features > Event Subscriptions > Enable > subscribe to bot events: `app_mention`, `message.channels`
5. **OAuth Scopes**: Features > OAuth & Permissions > Bot Token Scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `reactions:write`
6. **Install to Workspace** > save `xoxb-...` token
7. **Invite** bot to channel, get channel ID

## Env Vars

| Var | Description |
|-----|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-Level Token for Socket Mode (`xapp-...`) |
| `SLACK_CHANNEL_ID` | Channel ID to listen in (e.g. `C0123456789`) |
| `GITHUB_REPO` | Target repo context (default: `OpenRouterTeam/spawn`) |
| `REPO_ROOT` | Working directory for Claude Code (default: cwd) |

GitHub auth uses the `gh` CLI — run `gh auth login` before starting.

## `start-slack-bot.sh` Template

Create `.claude/skills/slack-bot/start-slack-bot.sh` (gitignored):

```bash
#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export SLACK_BOT_TOKEN="xoxb-YOUR-BOT-TOKEN"
export SLACK_APP_TOKEN="xapp-YOUR-APP-TOKEN"
export SLACK_CHANNEL_ID="C0000000000"
export GITHUB_REPO="OpenRouterTeam/spawn"
export REPO_ROOT="/home/lab/spawn"

exec bun run "${SCRIPT_DIR}/slack-bot.ts"
```

## Install

```bash
cd .claude/skills/slack-bot && bun install
```

## Systemd Service

Create `/etc/systemd/system/spawn-slack-bot.service`:

```ini
[Unit]
Description=Spawnis — Slack Claude Code Bot
After=network.target

[Service]
Type=simple
User=lab
Group=lab
WorkingDirectory=/home/lab/spawn/.claude/skills/slack-bot
ExecStart=/bin/bash /home/lab/spawn/.claude/skills/slack-bot/start-slack-bot.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="PATH=/home/lab/.bun/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spawn-slack-bot
```

## Verify

```bash
sudo systemctl status spawn-slack-bot
journalctl -u spawn-slack-bot -f

# Test: @mention Spawnis in channel → Claude Code runs, response streams back
# Test: Reply and @mention again → resumes same session
```

## State

Thread-to-session mappings are persisted at `~/.config/spawn/slack-issues.json`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERROR: SLACK_BOT_TOKEN env var is required` | Set all required env vars in `start-slack-bot.sh` |
| Bot doesn't respond to @mentions | Verify bot is invited to the channel; check `SLACK_CHANNEL_ID` |
| Claude errors with permission denied | Ensure `--dangerously-skip-permissions` is working, or run in a sandbox |
| Responses truncated | Slack has ~4000 char limit per message; long responses show the tail |
| Hourglass reaction | A Claude run is already active for that thread; wait for it to finish |
