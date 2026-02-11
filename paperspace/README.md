# Paperspace

Paperspace GPU cloud machines (now part of DigitalOcean) via CLI and REST API. [Paperspace](https://www.paperspace.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/paperspace/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/paperspace/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/paperspace/aider.sh)
```

## Non-Interactive Mode

```bash
PAPERSPACE_MACHINE_NAME=dev-mk1 \
PAPERSPACE_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/paperspace/claude.sh)
```

## Environment Variables

- `PAPERSPACE_API_KEY` - API key from https://console.paperspace.com/account/api
- `PAPERSPACE_MACHINE_NAME` - Name for the machine
- `PAPERSPACE_MACHINE_TYPE` - Machine type (default: C4)
- `PAPERSPACE_REGION` - Region (default: NY2, options: NY2, CA1, AMS1)
- `PAPERSPACE_DISK_SIZE` - Disk size in GB (default: 50)
- `OPENROUTER_API_KEY` - OpenRouter API key

## Features

- GPU machines starting at ~$0.46/hour (M4000) up to $1.90/hour (A6000)
- Hourly billing - only pay when machine is running (plus storage when stopped)
- Free unlimited bandwidth
- Three regions: NY2 (New York), CA1 (California), AMS1 (Amsterdam)
- Both CLI (pspace) and REST API support
- Full SSH access as root user

## Getting Started

1. Sign up at https://www.paperspace.com/
2. Create an API key at https://console.paperspace.com/account/api
3. Run any agent script - the pspace CLI will auto-install if needed
