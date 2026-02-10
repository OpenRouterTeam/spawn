# Railway

Railway serverless container platform via CLI. [Railway](https://railway.app/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/aider.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/nanoclaw.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/gptme.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/goose.sh)
```

## Non-Interactive Mode

```bash
RAILWAY_SERVICE_NAME=dev-mk1 \
RAILWAY_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RAILWAY_TOKEN` | Railway API token | _(CLI auth or prompted)_ |
| `RAILWAY_SERVICE_NAME` | Service name | _(prompted)_ |
| `RAILWAY_REGION` | Deployment region | `us-west1` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

## Notes

- Railway is a developer-focused container platform with per-second billing
- Fast provisioning times and automatic HTTPS
- Free tier available (requires credit card for verification)
- Uses Railway CLI for deployment and shell access
- Install CLI: `npm install -g @railway/cli` or `curl -fsSL https://railway.app/install.sh | sh`
