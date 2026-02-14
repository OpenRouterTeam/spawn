# Gcore

Gcore Cloud instances via REST API. [Gcore](https://gcore.com/cloud)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcore/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcore/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcore/goose.sh)
```

## Non-Interactive Mode

```bash
GCORE_SERVER_NAME=dev-mk1 \
GCORE_API_TOKEN=your-token \
GCORE_PROJECT_ID=12345 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcore/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GCORE_API_TOKEN` | Gcore API token | (prompted) |
| `GCORE_PROJECT_ID` | Gcore project ID | (auto-detected) |
| `GCORE_SERVER_NAME` | Instance hostname | (prompted) |
| `GCORE_REGION` | Gcore region | `ed-1` |
| `GCORE_FLAVOR` | Instance flavor | `g1-standard-1-2` |
| `OPENROUTER_API_KEY` | OpenRouter API key | (prompted/OAuth) |
