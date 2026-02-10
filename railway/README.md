# Railway

Deploy AI agents on Railway's container platform with per-minute billing.

## Overview

Railway is a modern container platform that offers:
- Per-minute billing (more granular than hourly)
- Instant deployment via CLI
- Docker-based containers
- $5 free trial credit
- Simple CLI interface with `railway run` for command execution

## Prerequisites

- Node.js or Bun (for Railway CLI installation)
- Railway account: [railway.app](https://railway.app/)
- Railway API token: [railway.app/account/tokens](https://railway.app/account/tokens)

## Authentication

Set your Railway API token:

```bash
export RAILWAY_TOKEN=your_token_here
```

Or the script will prompt you and save it to `~/.config/spawn/railway.json`.

## Usage

### Claude Code

```bash
bash railway/claude.sh
```

### Aider

```bash
bash railway/aider.sh
```

### Remote Execution

All scripts work via `curl | bash`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/railway/claude.sh)
```

## How It Works

1. **Project Creation**: Creates a Railway project via `railway init`
2. **Service Deployment**: Deploys an Ubuntu 24.04 Docker container with `railway up`
3. **Agent Installation**: Installs the agent inside the running container
4. **Environment Setup**: Configures OpenRouter API key and agent-specific env vars
5. **Interactive Session**: Drops you into the container with `railway run`

## Pricing

Railway uses usage-based pricing on top of a subscription:

- **Free Trial**: $5 credit (expires in 30 days)
- **Hobby Plan**: $5/month (includes $5 usage credit)
- **Pro Plan**: $20/month (includes $20 usage credit)

Additional usage beyond credits is billed per-minute for:
- CPU and memory utilization
- Bandwidth/egress
- Volume storage

See: [railway.app/pricing](https://railway.app/pricing)

## Notes

- Railway CLI requires Node.js or Bun
- Services run as Docker containers
- Per-minute billing means you only pay for active usage
- No SSH access - uses `railway run` for command execution
- Project and service are automatically created and managed

## Cleanup

Railway services persist after exit. To manually delete:

```bash
railway service delete --yes
railway project delete --yes
```

## Supported Agents

Currently implemented:
- Claude Code (`claude.sh`)
- Aider (`aider.sh`)

All other agents from the spawn matrix can be implemented using the same pattern.
