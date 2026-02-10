# Northflank

Northflank container platform via CLI with exec access. [Northflank](https://northflank.com/)

> Uses Northflank CLI for container exec. Free tier: 2 services. Pay-per-second pricing.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/aider.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/nanoclaw.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/gptme.sh)
```

## Setup

1. Create a Northflank account at https://northflank.com
2. Generate an API token at https://northflank.com/account/settings/api/tokens
3. Install the Northflank CLI:

```bash
npm install -g @northflank/cli
```

## Non-Interactive Mode

```bash
NORTHFLANK_SERVICE_NAME=spawn-dev \
NORTHFLANK_PROJECT_NAME=spawn-project \
NORTHFLANK_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/northflank/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NORTHFLANK_TOKEN` | Northflank API token | _(prompted)_ |
| `NORTHFLANK_SERVICE_NAME` | Service name | _(prompted)_ |
| `NORTHFLANK_PROJECT_NAME` | Project name | `spawn-project` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

## Free Tier

Northflank offers a Developer Sandbox with:
- 2 free services
- 2 free cron jobs
- 1 free database/add-on

Perfect for testing and hobby projects. Production apps should use pay-as-you-go pricing.

## Pricing

Pay-per-second usage-based pricing after free tier:
- Compute: $0.01667 per vCPU/hour, $0.00833 per GB memory/hour
- Disk: $0.30/GB per month
- Network egress: $0.15/GB
