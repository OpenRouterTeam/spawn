# BinaryLane Cloud Scripts

Deploy AI coding agents on BinaryLane's Australian cloud infrastructure.

## Overview

BinaryLane is an Australian cloud provider offering simple VPS hosting with hourly billing. These scripts provision servers via the BinaryLane REST API and deploy various AI agents with OpenRouter integration.

## Prerequisites

- BinaryLane API token (get from: https://home.binarylane.com.au/api-info)
- OpenRouter API key (get from: https://openrouter.ai/settings/keys)
- SSH key at `~/.ssh/id_ed25519` (auto-generated if missing)

## Usage

### Interactive Mode

```bash
# Deploy Claude Code
bash binarylane/claude.sh

# Deploy Goose
bash binarylane/goose.sh

# Deploy Plandex
bash binarylane/plandex.sh
```

### Non-Interactive Mode

Set environment variables for fully automated deployment:

```bash
export BINARYLANE_API_TOKEN="your-api-token"
export OPENROUTER_API_KEY="sk-or-v1-..."
export BINARYLANE_SERVER_NAME="my-agent-server"

# Optional: customize server configuration
export BINARYLANE_SIZE="std-2vcpu"      # default: std-1vcpu
export BINARYLANE_REGION="syd"           # default: syd (Sydney)
export BINARYLANE_IMAGE="ubuntu-24.04"   # default: ubuntu-24.04

bash binarylane/claude.sh
```

## Available Scripts

### Implemented
- `claude.sh` - Claude Code (Anthropic's CLI agent)
- `goose.sh` - Goose (Block's open-source agent)
- `plandex.sh` - Plandex (AI coding agent for complex tasks)

### Not Yet Implemented
- `openclaw.sh` - OpenClaw (OpenRouter's agent framework)
- `nanoclaw.sh` - NanoClaw (WhatsApp-based agent)
- `aider.sh` - Aider (AI pair programming)
- `codex.sh` - Codex CLI (OpenAI's agent)
- `interpreter.sh` - Open Interpreter
- `gemini.sh` - Gemini CLI
- `amazonq.sh` - Amazon Q CLI
- `cline.sh` - Cline
- `gptme.sh` - gptme
- `opencode.sh` - OpenCode

## Configuration

### Server Sizes
- `std-1vcpu` - 1 vCPU, 2 GB RAM (default)
- `std-2vcpu` - 2 vCPU, 4 GB RAM
- `std-4vcpu` - 4 vCPU, 8 GB RAM

See full pricing: https://www.binarylane.com.au/pricing

### Regions
- `syd` - Sydney, Australia (default)
- `per` - Perth, Australia
- `bne` - Brisbane, Australia
- `mel` - Melbourne, Australia

## Billing

BinaryLane uses hourly billing prorated from monthly rates:
- Charged from server creation to deletion
- Example: AUD 50/month = ~AUD 0.0694/hour
- Cancel anytime via `destroy_server <SERVER_ID>`

## API Documentation

Full API reference: https://api.binarylane.com.au/reference/

## Troubleshooting

### Authentication fails
- Verify API token at: https://home.binarylane.com.au/api-info
- Ensure token has read/write permissions
- Check token hasn't been revoked

### Server creation fails
- Insufficient account balance
- Size/region/image unavailable (try different values)
- Server limit reached
- Check: https://home.binarylane.com.au/

### SSH connection fails
- Wait 30-60s for cloud-init to complete
- Check firewall rules at BinaryLane dashboard
- Verify SSH key is registered: `curl -H "Authorization: Bearer $BINARYLANE_API_TOKEN" https://api.binarylane.com.au/v2/account/keys`

## Advanced Usage

### Using the Common Library

```bash
#!/bin/bash
source binarylane/lib/common.sh

ensure_binarylane_token
ensure_ssh_key
create_server "my-custom-server"
run_server "$BINARYLANE_SERVER_IP" "echo hello"
destroy_server "$BINARYLANE_SERVER_ID"
```

### List Running Servers

```bash
source binarylane/lib/common.sh
ensure_binarylane_token
list_servers
```

## Security

- API tokens stored in `~/.config/spawn/binarylane.json` (chmod 600)
- SSH keys auto-generated at `~/.ssh/id_ed25519`
- Temporary config files securely wiped on exit
- OpenRouter API keys injected via environment variables

## Remote Execution

These scripts support `bash <(curl -fsSL URL)` execution:

```bash
# Deploy Claude Code directly from GitHub
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/binarylane/claude.sh)
```
