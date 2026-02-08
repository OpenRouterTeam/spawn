# Fly.io

Fly.io Machines via REST API and flyctl CLI. [Fly.io](https://fly.io)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/plandex.sh)
```

## Non-Interactive Mode

```bash
FLY_APP_NAME=dev-mk1 \
FLY_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/fly/claude.sh)
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
