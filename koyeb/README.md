# Koyeb

Koyeb serverless container platform via CLI. [Koyeb](https://www.koyeb.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/koyeb/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/koyeb/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/koyeb/aider.sh)
```

## Non-Interactive Mode

```bash
KOYEB_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/koyeb/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KOYEB_TOKEN` | Koyeb API token | _(prompted)_ |
| `KOYEB_REGION` | Deployment region | `was` (Washington D.C.) |
| `KOYEB_INSTANCE_TYPE` | Instance type | `nano` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

## Authentication

Get your Koyeb API token at: https://app.koyeb.com/account/api

## Features

- Serverless container platform with per-second billing
- Free tier available (no credit card required)
- Fast deployment times
- Automatic scaling
- Global deployment regions
