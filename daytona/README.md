# Daytona

Daytona sandboxed environments for AI code execution. [Daytona](https://www.daytona.io/)

> Sub-90ms sandbox creation. True SSH support via `daytona ssh`. Requires `DAYTONA_API_KEY` from https://app.daytona.io.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/plandex.sh)
```

## Non-Interactive Mode

```bash
DAYTONA_SANDBOX_NAME=dev-mk1 \
DAYTONA_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/daytona/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DAYTONA_API_KEY` | Daytona API key | _(prompted)_ |
| `DAYTONA_SANDBOX_NAME` | Sandbox name | _(prompted)_ |
| `DAYTONA_CPU` | Number of vCPUs | `2` |
| `DAYTONA_MEMORY` | Memory in MB | `2048` |
| `DAYTONA_DISK` | Disk size in GB | `5` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |
