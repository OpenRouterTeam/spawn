# Civo

Civo cloud-native instances via REST API. [Civo](https://www.civo.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/plandex.sh)
```

## Non-Interactive Mode

```bash
CIVO_SERVER_NAME=dev-mk1 \
CIVO_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/civo/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CIVO_API_TOKEN` | Civo API token | (prompted) |
| `CIVO_SERVER_NAME` | Instance hostname | (prompted) |
| `CIVO_REGION` | Civo region | `lon1` |
| `CIVO_SIZE` | Instance size | `g4s.small` |
| `OPENROUTER_API_KEY` | OpenRouter API key | (prompted/OAuth) |
