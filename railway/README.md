# Railway

Railway container platform via CLI. [Railway](https://railway.app/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/plandex.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/kilocode.sh)
```

## Non-Interactive Mode

```bash
RAILWAY_SERVICE_NAME=my-agent \
RAILWAY_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RAILWAY_TOKEN` | Railway API token | _(prompted via browser login)_ |
| `RAILWAY_SERVICE_NAME` | Service name | _(prompted)_ |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

## Getting Started

1. Install Railway CLI:
   ```bash
   npm install -g @railway/cli
   # or
   bash <(curl -fsSL cli.new)
   ```

2. Login to Railway:
   ```bash
   railway login
   ```

3. Run a spawn script to deploy an agent

## Features

- Per-second billing
- Docker-based persistent containers
- Fast deployment (2-3 minutes)
- Interactive shell access via `railway run`
- Automatic OpenRouter integration
- Support for all 14 agents in the spawn matrix

## Authentication

Railway supports two authentication methods:

1. **Browser-based login** (default): Run `railway login`
2. **Token-based** (for automation): Set `RAILWAY_TOKEN` environment variable
   - Get your token at: https://railway.app/account/tokens
