# Crusoe Cloud

Crusoe Cloud GPU instances via CLI. [Crusoe Cloud](https://crusoecloud.com/)

## Prerequisites

1. Install the Crusoe CLI:

```bash
# Debian/Ubuntu
echo "deb [trusted=yes] https://apt.fury.io/crusoe/ * *" | sudo tee /etc/apt/sources.list.d/fury.list
sudo apt update && sudo apt install crusoe

# macOS/Other
# Visit: https://docs.crusoecloud.com/quickstart/install-cli
```

2. Generate API credentials at [Crusoe Console](https://console.crusoecloud.com/):
   - Navigate to: Security → API Access → Create Access Key
   - Save the Access Key ID and Secret Key

3. Create config file at `~/.crusoe/config`:

```ini
[default]
default_project="default"
access_key_id="YOUR_ACCESS_KEY_ID"
secret_key="YOUR_SECRET_KEY"
```

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/crusoe/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/crusoe/aider.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/crusoe/openclaw.sh)
```

## Non-Interactive Mode

```bash
CRUSOE_VM_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/crusoe/claude.sh)
```

## Environment Variables

- `CRUSOE_VM_NAME` - VM name (default: prompts)
- `CRUSOE_VM_TYPE` - VM type (default: `a40.1x`)
- `CRUSOE_LOCATION` - Location (default: `us-east1-a`)
- `OPENROUTER_API_KEY` - OpenRouter API key (default: prompts or OAuth)

## Available VM Types

List available VM types:

```bash
crusoe compute vm-types list
```

Common GPU types:
- `a40.1x` - NVIDIA A40 (default, 1 GPU)
- `l40s-48gb.8x` - NVIDIA L40S (8 GPUs)
- `h100-80gb-sxm-ib.8x` - NVIDIA H100 (8 GPUs)

## Pricing

Crusoe Cloud offers competitive GPU pricing starting at $1.45/GPU-hr for on-demand L40S instances. They also offer:

- **On-demand pricing** - Pay-per-hour, no commitment
- **Spot pricing** - Up to 90% discount vs hyperscalers
- **Reserved pricing** - 6-month to 3-year commitments for additional savings

View pricing: [https://crusoecloud.com/pricing](https://crusoecloud.com/pricing)

## Locations

List available locations:

```bash
crusoe compute datacenter-regions list
```

Common regions:
- `us-east1-a` - US East (default)
- `us-southcentral1-a` - US South Central
- `us-northcentral1-a` - US North Central

## Notes

- GPU-focused cloud provider with carbon-reducing infrastructure
- Supports NVIDIA H200/H100/L40S/A100 and AMD MI300X GPUs
- VMs run Ubuntu 22.04 by default
- Uses `root` user for SSH access
- Startup scripts support cloud-init format
