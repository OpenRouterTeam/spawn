# FluidStack

FluidStack GPU cloud via REST API. [FluidStack](https://www.fluidstack.io/)

## Prerequisites

1. A FluidStack account with API key from [Dashboard API Keys](https://platform.fluidstack.io/dashboard/api-keys)
2. SSH public key (will be registered automatically)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fluidstack/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fluidstack/aider.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/fluidstack/gptme.sh)
```

## Non-Interactive Mode

```bash
FLUIDSTACK_SERVER_NAME=dev-gpu \
FLUIDSTACK_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/fluidstack/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FLUIDSTACK_API_KEY` | FluidStack API key | _(prompted)_ |
| `FLUIDSTACK_SERVER_NAME` | Instance name | _(prompted)_ |
| `FLUIDSTACK_GPU_TYPE` | GPU type (e.g., `RTX_4090`, `A100`, `H100`) | `RTX_4090` |
| `FLUIDSTACK_SSH_KEY_NAME` | SSH key name | `spawn-${USER}` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(prompted via OAuth)_ |

## Notes

- FluidStack is a GPU cloud provider with A100s and H100s starting at $1.35/hr
- Up to 70% cheaper than traditional hyperscalers
- Zero egress fees for data transfer
- Simple REST API with Python SDK available
- SSH keys are automatically registered via the API
- Instances use the `root` user for SSH access
