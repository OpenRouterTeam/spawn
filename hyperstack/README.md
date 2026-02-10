# Hyperstack Cloud Scripts

Spawn scripts for deploying AI agents on [Hyperstack](https://www.hyperstack.cloud/) GPU cloud infrastructure.

## What is Hyperstack?

Hyperstack (formerly NexGen Cloud) is a GPU cloud provider offering competitive pricing on NVIDIA GPUs, including:
- **RTX A6000** (48GB) - $0.50/hour on-demand, $0.35/hour reserved
- **RTX A4000**, **A100**, **H100**, and other high-performance GPUs
- Pay-per-minute billing for on-demand instances
- Global availability across multiple regions

## Setup

### 1. Get Hyperstack API Key

1. Sign up at [Hyperstack Infrahub](https://infrahub.hyperstack.cloud)
2. Navigate to **Settings → API Keys**
3. Create a new API key
4. Copy the API key

### 2. Set Environment Variable

```bash
export HYPERSTACK_API_KEY="your-api-key-here"
```

Or the script will prompt you and save it to `~/.config/spawn/hyperstack.json`.

### 3. Choose an Environment

Hyperstack organizes resources by "environments" (e.g., `default-CANADA-1`, `default-EU-1`). The script will:
- Use `HYPERSTACK_ENVIRONMENT` if set
- Otherwise, fetch available environments and prompt you to choose

List available environments:
```bash
curl -H "api_key: YOUR_API_KEY" \
  https://infrahub-api.nexgencloud.com/v1/core/environments | jq '.environments[] | {name, region}'
```

## Usage

```bash
# Claude Code on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/claude.sh)

# Aider on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/aider.sh)

# OpenClaw on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/openclaw.sh)

# NanoClaw on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/nanoclaw.sh)

# Goose on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/goose.sh)

# Codex on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/codex.sh)

# Open Interpreter on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/interpreter.sh)

# Gemini CLI on Hyperstack
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/gemini.sh)
```

## Configuration Options

### Environment Variables

- `HYPERSTACK_API_KEY` - API key from Hyperstack Infrahub (required)
- `HYPERSTACK_ENVIRONMENT` - Environment name (e.g., `default-CANADA-1`)
- `HYPERSTACK_FLAVOR` - VM flavor/size (default: `n1-cpu-small`)
- `HYPERSTACK_IMAGE` - OS image (default: `Ubuntu Server 24.04 LTS R5504 UEFI`)
- `HYPERSTACK_VM_NAME` - Custom VM name (default: prompts interactively)
- `HYPERSTACK_SSH_KEY_NAME` - SSH key name (default: `spawn-key-$(whoami)`)

### Example with Environment Variables

```bash
export HYPERSTACK_API_KEY="your-key"
export HYPERSTACK_ENVIRONMENT="default-CANADA-1"
export HYPERSTACK_FLAVOR="n1-cpu-medium"
export HYPERSTACK_VM_NAME="my-claude-vm"

bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hyperstack/claude.sh)
```

## Available Flavors

To list available VM flavors:

```bash
curl -H "api_key: YOUR_API_KEY" \
  https://infrahub-api.nexgencloud.com/v1/core/flavors | jq '.flavors[] | {name, cpu, ram, gpu}'
```

Common flavors:
- `n1-cpu-small` - 1 vCPU, 2GB RAM
- `n1-cpu-medium` - 2 vCPU, 4GB RAM
- `n1-cpu-large` - 4 vCPU, 8GB RAM
- GPU flavors with RTX A6000, A100, H100, etc.

## Available Images

To list available OS images:

```bash
curl -H "api_key: YOUR_API_KEY" \
  https://infrahub-api.nexgencloud.com/v1/core/images | jq '.images[] | {name, version}'
```

## Pricing

Hyperstack uses pay-per-minute billing for on-demand instances. Pricing is calculated per GPU per hour.

**Example pricing** (subject to change):
- RTX A6000 (48GB): $0.50/hour on-demand, $0.35/hour reserved
- Reserved instances offer ~30% savings over on-demand

Check current pricing at [Hyperstack Pricing](https://www.hyperstack.cloud/pricing) or via the API pricebook endpoints.

## API Documentation

Full API reference: [Hyperstack API Docs](https://docs.hyperstack.cloud)

Base URL: `https://infrahub-api.nexgencloud.com/v1`

## Billing Notes

- VMs are only billed when in `ACTIVE` or `SHUTOFF` states
- `HIBERNATED` VMs only charge for storage and public IP
- Transitional states (e.g., `HIBERNATING`, `RESTORING`) are not charged
- Minimum billing period is 1 minute

## Troubleshooting

### API Key Invalid

If you see authentication errors:
1. Verify your API key at https://infrahub.hyperstack.cloud
2. Ensure the key has proper permissions (not read-only)
3. Check that the key hasn't been revoked

### Environment Not Found

If the environment name is invalid:
1. List available environments: `curl -H "api_key: KEY" https://infrahub-api.nexgencloud.com/v1/core/environments`
2. Use the exact name from the API response (case-sensitive)
3. Set `HYPERSTACK_ENVIRONMENT` to the correct name

### VM Creation Fails

Common issues:
- Insufficient quota in the selected environment
- Flavor not available in the selected region
- SSH key name conflicts with existing key
- Invalid security rules

## Support

- [Hyperstack Documentation](https://docs.hyperstack.cloud)
- [Hyperstack Support](https://www.hyperstack.cloud/support)
- [Spawn GitHub Issues](https://github.com/OpenRouterTeam/spawn/issues)
