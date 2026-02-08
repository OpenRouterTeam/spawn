# Civo

Civo cloud-native instances via REST API. [Civo](https://www.civo.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/civo/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/civo/aider.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/civo/codex.sh)
```

## Non-Interactive Mode

```bash
CIVO_SERVER_NAME=dev-mk1 \
CIVO_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/civo/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CIVO_API_TOKEN` | Civo API token | (prompted) |
| `CIVO_SERVER_NAME` | Instance hostname | (prompted) |
| `CIVO_REGION` | Civo region | `NYC1` |
| `CIVO_SIZE` | Instance size | `g3.medium` |
| `OPENROUTER_API_KEY` | OpenRouter API key | (prompted/OAuth) |
