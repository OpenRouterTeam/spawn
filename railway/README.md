# Railway

Railway container platform via CLI. [Railway](https://railway.app/)

> Pay-per-minute billing. Fast deployment. Uses websocket-based SSH protocol (not standard SSH). Requires Railway CLI.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/aider.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/gptme.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/nanoclaw.sh)
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

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/plandex.sh)
```

## Non-Interactive Mode

```bash
RAILWAY_PROJECT_NAME=dev-mk1 \
RAILWAY_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/railway/claude.sh)
```

## Authentication

Railway CLI requires authentication. You can authenticate in three ways:

1. **Interactive login** (default): `railway login` opens a browser for OAuth
2. **Project token**: Set `RAILWAY_TOKEN` environment variable from https://railway.app/account/tokens
3. **Stored credentials**: After running `railway login`, credentials are stored and reused

For CI/CD pipelines, use project tokens via the `RAILWAY_TOKEN` environment variable.

## Pricing

Railway uses pay-per-minute billing for compute resources. You only pay for what you use:

- **Free tier**: $5 of free credits per month
- **Hobby plan**: $5/month subscription + usage-based pricing
- **Pro plan**: $20/month subscription + usage-based pricing with higher limits

Pricing is prorated to the minute, so you're not paying for idle resources when your service is stopped.

## Limits

- Project name: 1-50 characters, lowercase letters, numbers, and hyphens
- Must start and end with alphanumeric character
- No standard SSH access (uses Railway's websocket-based protocol)
- Requires Railway CLI for all operations

## Troubleshooting

### Railway CLI not found

Install via npm:
```bash
npm install -g @railway/cli
```

Or use the official installer:
```bash
bash <(curl -fsSL cli.new)
```

### Authentication failed

Generate a new token at https://railway.app/account/tokens and set:
```bash
export RAILWAY_TOKEN=your-token-here
```

### Project already exists

If you get "project already exists", Railway will attempt to reuse the existing project. If this causes issues, you can either:
1. Use a different project name
2. Delete the old project from https://railway.app/dashboard
3. Use `railway link` to link to an existing project

## Resources

- Railway Documentation: https://docs.railway.com/
- Railway CLI Reference: https://docs.railway.com/reference/cli-api
- Railway Dashboard: https://railway.app/dashboard
- Generate API Tokens: https://railway.app/account/tokens
