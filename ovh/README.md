# OVHcloud

OVHcloud Public Cloud instances via REST API. [OVHcloud](https://www.ovhcloud.com/)

## Setup

OVHcloud uses signature-based API authentication. You need:

1. **Application Key** and **Application Secret** - Create at [https://api.ovh.com/createToken/](https://api.ovh.com/createToken/)
2. **Consumer Key** - Generated during token creation
3. **Project ID** - Find at [OVH Manager](https://www.ovh.com/manager/public-cloud/) (select project -> Project ID)

Required API permissions:
- `GET /cloud/project/*`
- `POST /cloud/project/*`
- `DELETE /cloud/project/*`
- `GET /me`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OVH_APPLICATION_KEY` | OVH Application Key |
| `OVH_APPLICATION_SECRET` | OVH Application Secret |
| `OVH_CONSUMER_KEY` | OVH Consumer Key |
| `OVH_PROJECT_ID` | OVH Public Cloud Project ID |
| `OVH_SERVER_NAME` | Instance name (optional, prompted if not set) |
| `OVH_FLAVOR` | Instance flavor (default: `d2-2`) |
| `OVH_REGION` | Region (default: `GRA7`) |
| `OVH_SSH_USER` | SSH user (default: `ubuntu`) |

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/aider.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/codex.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/goose.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/interpreter.sh)
```

## Non-Interactive Mode

```bash
OVH_SERVER_NAME=dev-mk1 \
OVH_APPLICATION_KEY=your-app-key \
OVH_APPLICATION_SECRET=your-app-secret \
OVH_CONSUMER_KEY=your-consumer-key \
OVH_PROJECT_ID=your-project-id \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/ovh/claude.sh)
```
