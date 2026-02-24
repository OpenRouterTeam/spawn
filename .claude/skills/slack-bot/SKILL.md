---
name: slack-bot
description: Slack issue bot — files GitHub issues from @mentions, syncs thread replies as comments
disable-model-invocation: true
---

# Slack Issue Bot

Listens in `#proj-spawn` via Socket Mode. When @mentioned, files a GitHub issue via `gh` CLI. Thread replies sync as issue comments.

## Slack App Setup (one-time)

1. Go to https://api.slack.com/apps and click **Create New App** > **From scratch**
2. Name it (e.g. `Spawn Issue Bot`), select the workspace
3. **Socket Mode**: Settings > Socket Mode > Enable. Generate an app-level token with `connections:write` scope. Save the `xapp-...` token.
4. **Event Subscriptions**: Features > Event Subscriptions > Enable. Subscribe to bot events:
   - `app_mention`
   - `message.channels`
5. **OAuth Scopes**: Features > OAuth & Permissions > Bot Token Scopes:
   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `reactions:write`
6. **Install to Workspace**: Features > OAuth & Permissions > Install. Save the `xoxb-...` Bot User OAuth Token.
7. **Invite the bot** to the target channel: `/invite @Spawn Issue Bot`
8. **Get the channel ID**: Right-click channel name > View channel details > copy the ID at the bottom (starts with `C`).

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- `bun` installed

## Env Vars

| Var | Description |
|-----|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-Level Token for Socket Mode (`xapp-...`) |
| `SLACK_CHANNEL_ID` | Channel ID to listen in (e.g. `C0123456789`) |
| `GITHUB_REPO` | Target repo (default: `OpenRouterTeam/spawn`) |

GitHub auth is handled by the `gh` CLI — no token env var needed.

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
Description=Spawn Slack Issue Bot
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
# Check service status
sudo systemctl status spawn-slack-bot

# Follow logs
journalctl -u spawn-slack-bot -f

# Test: @mention bot in channel → GitHub issue created
# Test: Reply in tracked thread → comment appears on issue
```

## State

Thread-to-issue mappings are persisted at `~/.config/spawn/slack-issues.json`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ERROR: SLACK_BOT_TOKEN env var is required` | Set all required env vars in `start-slack-bot.sh` |
| Bot doesn't respond to @mentions | Verify bot is invited to the channel; check `SLACK_CHANNEL_ID` matches |
| `gh issue create failed` | Run `gh auth status` to verify auth; run `gh auth login` if needed |
| Socket disconnects | Service auto-restarts via systemd; check `journalctl` for root cause |
| Duplicate issues from same thread | State file may be corrupted — check `~/.config/spawn/slack-issues.json` |
