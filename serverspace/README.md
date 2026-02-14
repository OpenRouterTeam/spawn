# ServerSpace

ServerSpace cloud servers via REST API with global locations. [ServerSpace](https://serverspace.io/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/serverspace/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/serverspace/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/serverspace/goose.sh)
```

## Non-Interactive Mode

```bash
SERVERSPACE_SERVER_NAME=dev-mk1 \
SERVERSPACE_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/serverspace/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVERSPACE_API_KEY` | ServerSpace API key | (prompted) |
| `SERVERSPACE_SERVER_NAME` | Server hostname | (prompted) |
| `SERVERSPACE_LOCATION` | Server location | `nl1` |
| `SERVERSPACE_CPU` | Number of CPU cores | `1` |
| `SERVERSPACE_RAM_MB` | RAM in MB | `1024` |
| `SERVERSPACE_DISK_MB` | Boot disk in MB | `25600` |
| `OPENROUTER_API_KEY` | OpenRouter API key | (prompted/OAuth) |

## Getting an API Key

1. Sign up at [ServerSpace](https://serverspace.io/)
2. Go to [API settings](https://my.serverspace.io/project/api)
3. Generate an API key
4. Set it as `SERVERSPACE_API_KEY` or paste when prompted
