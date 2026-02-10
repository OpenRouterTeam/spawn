# Vast.ai

Vast.ai GPU marketplace via CLI. [Vast.ai](https://vast.ai/)

## Prerequisites

1. A Vast.ai account with API key from [Account Settings](https://cloud.vast.ai/account/)
2. Python 3 with pip (for installing the `vastai` CLI)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vastai/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vastai/aider.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vastai/codex.sh)
```

## Non-Interactive Mode

```bash
VASTAI_SERVER_NAME=dev-gpu \
VASTAI_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/vastai/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `VASTAI_API_KEY` | Vast.ai API key | _(prompted)_ |
| `VASTAI_SERVER_NAME` | Instance label | _(prompted)_ |
| `VASTAI_GPU_TYPE` | GPU type to search for | `RTX_4090` |
| `VASTAI_DISK_GB` | Disk size in GB | `40` |
| `VASTAI_IMAGE` | Docker image | `nvidia/cuda:12.1.0-devel-ubuntu22.04` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(prompted via OAuth)_ |

## Notes

- Vast.ai is a GPU marketplace -- instances come with NVIDIA GPUs and CUDA pre-installed
- The `vastai` CLI is installed automatically if not present (`pip install vastai`)
- Instances are Docker containers; base tools are installed automatically on first run
- SSH access is via dynamic port mapping (non-standard ports)
- Pricing is per-hour, varies by GPU type and availability
