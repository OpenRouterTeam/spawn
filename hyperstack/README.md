# Hyperstack

Hyperstack GPU cloud via REST API. [Hyperstack](https://www.hyperstack.cloud/)

> Hyperstack (formerly NexGen Cloud) offers NVIDIA GPUs with pay-per-minute billing.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/plandex.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/kilocode.sh)
```

## Setup

### 1. Get Hyperstack API Key

1. Sign up at [Hyperstack Infrahub](https://infrahub.hyperstack.cloud)
2. Navigate to **Settings -> API Keys**
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

## Non-Interactive Mode

```bash
HYPERSTACK_API_KEY=your-key \
HYPERSTACK_ENVIRONMENT=default-CANADA-1 \
HYPERSTACK_VM_NAME=my-vm \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/hyperstack/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HYPERSTACK_API_KEY` | API key from Hyperstack Infrahub | _(required)_ |
| `HYPERSTACK_ENVIRONMENT` | Environment name | _(prompted)_ |
| `HYPERSTACK_FLAVOR` | VM flavor/size | `n1-cpu-small` |
| `HYPERSTACK_IMAGE` | OS image | `Ubuntu Server 24.04 LTS R5504 UEFI` |
| `HYPERSTACK_VM_NAME` | Custom VM name | _(prompted)_ |
| `HYPERSTACK_SSH_KEY_NAME` | SSH key name | `spawn-key-$(whoami)` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

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
