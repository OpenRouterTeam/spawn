# Scaleway

Scaleway Cloud instances via REST API. [Scaleway](https://www.scaleway.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/opencode.sh)
```

## Non-Interactive Mode

```bash
SCALEWAY_SERVER_NAME=dev-mk1 \
SCW_SECRET_KEY=your-secret-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/scaleway/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SCW_SECRET_KEY` | Scaleway API secret key (required) | - |
| `SCW_DEFAULT_PROJECT_ID` | Scaleway project ID (auto-detected if not set) | - |
| `SCALEWAY_SERVER_NAME` | Server name | prompted |
| `SCALEWAY_ZONE` | Availability zone | `fr-par-1` |
| `SCALEWAY_TYPE` | Commercial type (instance size) | `DEV1-S` |
| `OPENROUTER_API_KEY` | OpenRouter API key | prompted via OAuth |
