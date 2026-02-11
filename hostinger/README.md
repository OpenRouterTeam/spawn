# Hostinger VPS

Hostinger is a budget VPS provider with cloud-init support and REST API provisioning. Starting at $4.95/month for 1 vCPU + 4GB RAM instances with hourly billing.

## Quick Start

Each script provisions a Hostinger VPS, installs the agent, injects OpenRouter credentials, and drops you into an interactive session.

### Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/claude.sh)
```

### Aider

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/aider.sh)
```

### OpenClaw

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/openclaw.sh)
```

## Non-Interactive Mode

All scripts support non-interactive execution via environment variables:

```bash
export HOSTINGER_API_KEY="your-api-key"
export HOSTINGER_SERVER_NAME="my-vps"
export HOSTINGER_PLAN="kvm1"              # Optional (default: kvm1)
export HOSTINGER_LOCATION="eu-central"    # Optional (default: eu-central)
export OPENROUTER_API_KEY="your-key"      # Optional (triggers OAuth if unset)

bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/claude.sh)
```

## Configuration

### Authentication

Get your Hostinger API key:
1. Log into hPanel: https://hpanel.hostinger.com/
2. Click your Profile icon → Account Information
3. Navigate to API in the sidebar
4. Click 'Generate token' or 'New token'
5. Set token name and expiration, then click Generate
6. Copy the token: `export HOSTINGER_API_KEY=...`

The token will be saved to `~/.config/spawn/hostinger.json` for reuse.

### VPS Plans

Common plans (hourly pricing estimated from monthly):
- `kvm1`: 1 vCPU, 4GB RAM, 50GB SSD (~$0.0068/hr)
- `kvm2`: 2 vCPU, 8GB RAM, 100GB SSD (~$0.0137/hr)
- `kvm4`: 4 vCPU, 16GB RAM, 200GB SSD (~$0.0274/hr)

The script will show available plans if `HOSTINGER_PLAN` is not set.

### Locations

Available regions:
- `eu-central` (default) - Europe, Central
- `us-east` - United States, East Coast
- `asia-pacific` - Asia Pacific

The script will show available locations if `HOSTINGER_LOCATION` is not set.

### OS Templates

Default: `ubuntu-24.04`

Override with:
```bash
export HOSTINGER_OS_TEMPLATE="ubuntu-22.04"
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOSTINGER_API_KEY` | API authentication token | Required (prompted if unset) |
| `HOSTINGER_SERVER_NAME` | VPS hostname | Required (prompted if unset) |
| `HOSTINGER_PLAN` | VPS plan ID | `kvm1` (interactive picker if unset) |
| `HOSTINGER_LOCATION` | Region/datacenter | `eu-central` (interactive picker if unset) |
| `HOSTINGER_OS_TEMPLATE` | Operating system | `ubuntu-24.04` |
| `OPENROUTER_API_KEY` | OpenRouter API key | OAuth flow if unset |

## SSH Key Management

The scripts automatically:
1. Generate `~/.ssh/spawn_ed25519` keypair if missing
2. Register the public key with Hostinger API
3. Wait for SSH connectivity after VPS creation

To use an existing key:
```bash
export SPAWN_SSH_KEY_PATH="$HOME/.ssh/id_ed25519"
```

## Management

### List VPSs

```bash
source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/lib/common.sh)
ensure_hostinger_token
list_servers
```

### Destroy VPS

```bash
source <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/hostinger/lib/common.sh)
ensure_hostinger_token
destroy_server "12345"  # Replace with VPS ID from list_servers
```

## Cloud-Init Support

All Hostinger VPS instances come with cloud-init pre-installed. The scripts inject userdata to:
- Install bun (JavaScript runtime)
- Install common tools (git, curl, zsh, etc.)
- Configure shell environment
- Set up OpenRouter API key injection

## Pricing

- Pay-per-hour billing (billed monthly based on usage)
- Starting at $4.95/month for kvm1 plan
- No bandwidth charges
- No setup fees

## API Documentation

Hostinger VPS API base: `https://api.hostinger.com/vps/v1`

Common endpoints:
- `GET /virtual-machines` - List VPSs
- `POST /virtual-machines` - Create VPS
- `DELETE /virtual-machines/{id}` - Destroy VPS
- `GET /ssh-keys` - List SSH keys
- `POST /ssh-keys` - Register SSH key
- `GET /plans` - List available plans
- `GET /locations` - List available regions

Authentication: Bearer token via `Authorization` header
