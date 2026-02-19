# Fly.io

Fly.io Machines via REST API and flyctl CLI. [Fly.io](https://fly.io)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/kilocode.sh)
```

## Non-Interactive Mode

```bash
FLY_APP_NAME=dev-mk1 \
FLY_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FLY_API_TOKEN` | Fly.io API token | _(prompted or from flyctl auth)_ |
| `FLY_APP_NAME` | App name | _(prompted)_ |
| `FLY_REGION` | Deployment region | `iad` |
| `FLY_VM_SIZE` | VM size | `shared-cpu-1x` |
| `FLY_VM_MEMORY` | VM memory (MB) | `1024` |
| `FLY_ORG` | Organization slug | `personal` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |
