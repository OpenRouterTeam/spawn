# RunPod

RunPod GPU cloud pods via GraphQL API. [RunPod](https://www.runpod.io/)

## Prerequisites

1. A RunPod account with API key from [Settings](https://www.runpod.io/console/user/settings)
2. SSH public key added to your RunPod account (same settings page)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/plandex.sh)
```

## Non-Interactive Mode

```bash
RUNPOD_SERVER_NAME=dev-gpu \
RUNPOD_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/runpod/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `RUNPOD_API_KEY` | RunPod API key | _(prompted)_ |
| `RUNPOD_SERVER_NAME` | Pod name | _(prompted)_ |
| `RUNPOD_GPU_TYPE` | GPU type ID | `NVIDIA RTX A4000` |
| `RUNPOD_GPU_COUNT` | Number of GPUs | `1` |
| `RUNPOD_IMAGE` | Docker image | `runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04` |
| `RUNPOD_VOLUME_GB` | Persistent volume size (GB) | `50` |
| `RUNPOD_CONTAINER_DISK_GB` | Container disk size (GB) | `20` |
| `RUNPOD_CLOUD_TYPE` | Cloud type (`ALL`, `COMMUNITY`, `SECURE`) | `ALL` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(prompted via OAuth)_ |

## Notes

- RunPod is a GPU cloud provider -- pods come with NVIDIA GPUs and CUDA pre-installed
- SSH keys must be added via the RunPod web console (not via API)
- Pods use Docker containers; base tools are installed automatically on first run
- SSH access is via direct TCP port mapping or RunPod's SSH proxy
