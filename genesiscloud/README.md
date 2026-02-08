# Genesis Cloud

Genesis Cloud GPU instances via REST API. [Genesis Cloud](https://www.genesiscloud.com/)

> GPU cloud provider with NVIDIA RTX 3080/3090, A100, and H100 instances. European data centers (Iceland, Norway).

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/aider.sh)
```

## Non-Interactive Mode

```bash
GENESIS_SERVER_NAME=dev-mk1 \
GENESIS_API_KEY=your-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/claude.sh)
```

## Configuration

- **GENESIS_API_KEY**: API key from [Genesis Cloud Developer Portal](https://developers.genesiscloud.com/)
- **GENESIS_SERVER_NAME**: Name for the instance
- **GENESIS_INSTANCE_TYPE**: Instance type (default: `vcpu-4_memory-12g_nvidia-rtx-3080-1`)
- **GENESIS_REGION**: Region (default: `ARC-IS-HAF-1`)
- **GENESIS_IMAGE**: Image name (default: `Ubuntu 24.04`)
- **OPENROUTER_API_KEY**: OpenRouter API key

## Available Instance Types

Genesis Cloud offers various GPU instance types:

- **NVIDIA RTX 3080**: `vcpu-4_memory-12g_nvidia-rtx-3080-1`
- **NVIDIA RTX 3090**: `vcpu-8_memory-30g_nvidia-rtx-3090-1`
- **NVIDIA A100 (40GB)**: `vcpu-24_memory-200g_nvidia-a100-40gb-1`
- **NVIDIA H100 (80GB)**: `vcpu-26_memory-200g_nvidia-h100-80gb-sxm-1`

See [Genesis Cloud Pricing](https://www.genesiscloud.com/pricing) for full list and pricing.

## Region Options

- `ARC-IS-HAF-1` - Hafnarfjordur, Iceland (default)
- `ARC-NO-OSL-1` - Oslo, Norway

## Notes

- Uses `root` user for SSH access
- SSH keys are managed via the Genesis Cloud API
- Instances support cloud-init for automated setup
- All instances come with Ubuntu 24.04 by default
- GPU instances include NVIDIA drivers pre-installed
