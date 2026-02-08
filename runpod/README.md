# RunPod GPU Cloud

Deploy AI coding agents on RunPod's GPU cloud infrastructure.

## Overview

RunPod provides on-demand GPU instances (pods) with per-second billing, ideal for GPU-accelerated AI workloads. Spawn uses RunPod's GraphQL API to provision GPU pods with SSH access.

## Authentication

RunPod requires an API key with GraphQL permissions:

1. Visit https://www.runpod.io/console/user/settings
2. Navigate to "API Keys" section
3. Click "Create API Key"
4. Select permissions: **GraphQL** (required)
5. Copy the generated API key

### Environment Variable

Set `RUNPOD_API_KEY` to use non-interactively:

```bash
export RUNPOD_API_KEY="your-api-key-here"
```

Or the scripts will prompt you interactively and save to `~/.config/spawn/runpod.json`.

## Configuration

RunPod scripts support these environment variables:

- `RUNPOD_API_KEY` - API key (required)
- `RUNPOD_POD_NAME` - Pod name (default: prompt)
- `RUNPOD_GPU_TYPE` - GPU model (default: "NVIDIA GeForce RTX 4090")
- `RUNPOD_GPU_COUNT` - Number of GPUs (default: 1)
- `RUNPOD_CLOUD_TYPE` - Cloud type: ALL, SECURE, COMMUNITY (default: ALL)
- `RUNPOD_DISK_SIZE` - Container disk size in GB (default: 40)
- `RUNPOD_VOLUME_SIZE` - Persistent volume size in GB (default: 40)
- `RUNPOD_IMAGE` - Docker image (default: runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04)
- `OPENROUTER_API_KEY` - OpenRouter API key for agents

## Available GPU Types

Common GPU options for `RUNPOD_GPU_TYPE`:

- `NVIDIA GeForce RTX 4090` (default, consumer GPU, affordable)
- `NVIDIA RTX A6000` (professional workstation GPU)
- `NVIDIA A100 80GB PCIe` (data center GPU, high memory)
- `NVIDIA A100-SXM4-80GB` (high-end data center GPU)
- `NVIDIA H100 80GB HBM3` (latest generation, highest performance)

Check https://www.runpod.io/console/gpu-cloud for current availability and pricing.

## Usage Examples

### Claude Code on RunPod

```bash
# Default RTX 4090 GPU
bash runpod/claude.sh

# Use A100 GPU with more resources
RUNPOD_GPU_TYPE="NVIDIA A100 80GB PCIe" \
RUNPOD_DISK_SIZE=100 \
RUNPOD_VOLUME_SIZE=100 \
bash runpod/claude.sh

# Non-interactive with all env vars
RUNPOD_API_KEY="your-key" \
RUNPOD_POD_NAME="my-claude-pod" \
OPENROUTER_API_KEY="sk-or-v1-..." \
bash runpod/claude.sh
```

### Aider on RunPod

```bash
bash runpod/aider.sh
```

### OpenClaw on RunPod

```bash
bash runpod/openclaw.sh
```

## Pricing

RunPod bills per second while your pod is running:

- **RTX 4090**: ~$0.34/hour
- **A6000**: ~$0.79/hour
- **A100 80GB**: ~$1.89/hour
- **H100 80GB**: ~$4.89/hour

Pricing varies by availability and cloud type (SECURE vs COMMUNITY). Check current rates at https://www.runpod.io/console/gpu-cloud.

**Cost optimization:**
- Use COMMUNITY cloud for lower prices (peer-to-peer network)
- Terminate pods when not in use (billed per second)
- Use smaller disk/volume sizes if you don't need storage
- Start with RTX 4090 for development, upgrade to A100/H100 for production

## SSH Access

RunPod pods expose SSH on a custom port (not 22). The scripts automatically:

1. Configure SSH public key injection via `SSH_PUBLIC_KEY` env var
2. Open port 22/tcp in pod configuration
3. Extract the mapped public IP and port from the pod runtime
4. Connect via `ssh -p PORT root@IP`

## Cloud Types

- **ALL**: Deploy to any available cloud (SECURE or COMMUNITY)
- **SECURE**: Data center infrastructure (higher reliability, higher cost)
- **COMMUNITY**: Peer-to-peer GPU network (lower cost, variable availability)

## Troubleshooting

### Authentication Issues

```
API Error: Invalid authorization token
```

**Fix**: Verify your API key has GraphQL permissions at https://www.runpod.io/console/user/settings

### GPU Unavailable

```
Failed to create RunPod pod: GPU type unavailable
```

**Fix**: Try a different GPU type or cloud type:

```bash
RUNPOD_GPU_TYPE="NVIDIA RTX A6000" bash runpod/claude.sh
# or
RUNPOD_CLOUD_TYPE="COMMUNITY" bash runpod/claude.sh
```

### SSH Connection Timeout

```
Pod failed to respond via SSH after 30 attempts
```

**Fix**: The pod may still be initializing. Wait 1-2 minutes and try connecting manually:

```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no -p PORT root@IP
```

Get IP and PORT from the pod details at https://www.runpod.io/console/pods

### Insufficient Credits

```
Failed to create instance: Insufficient credits
```

**Fix**: Add credits to your account at https://www.runpod.io/console/user/billing

## Remote Execution

All RunPod scripts support curl|bash execution:

```bash
# Claude on RunPod (curl|bash)
RUNPOD_API_KEY="your-key" \
RUNPOD_POD_NAME="my-pod" \
OPENROUTER_API_KEY="sk-or-v1-..." \
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/runpod/claude.sh)
```

## API Reference

- GraphQL API: https://api.runpod.io/graphql
- OpenAPI Spec: https://api.runpod.io/openapi.json
- Documentation: https://docs.runpod.io

## Features

- ✅ Per-second billing (no minimum commitment)
- ✅ Wide selection of consumer and enterprise GPUs
- ✅ SSH access with public key auth
- ✅ Persistent volumes for data storage
- ✅ SECURE and COMMUNITY cloud options
- ✅ GraphQL API for programmatic control
- ✅ Pre-configured Docker images with CUDA/PyTorch
