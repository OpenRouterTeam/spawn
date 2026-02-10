# Cherry Servers

Cherry Servers is a European cloud provider offering bare metal and cloud VPS with full root access, hourly billing, and a REST API.

## Authentication

All Cherry Servers scripts require a `CHERRY_AUTH_TOKEN` environment variable.

### Getting your API token

1. Visit [Cherry Servers Portal](https://portal.cherryservers.com/)
2. Click on your profile in the top right
3. Navigate to API Tokens
4. Create a new token or copy an existing one

### Setting the token

```bash
export CHERRY_AUTH_TOKEN="your-token-here"
```

## Configuration

Optional environment variables:

- `CHERRY_AUTH_TOKEN` - API authentication token (required)
- `CHERRY_DEFAULT_PLAN` - Server plan (default: `cloud_vps_1`)
- `CHERRY_DEFAULT_REGION` - Deployment region (default: `eu_nord_1`)
- `CHERRY_DEFAULT_IMAGE` - OS image (default: `Ubuntu 24.04 64bit`)
- `CHERRY_SERVER_NAME` - Custom server hostname

## Available Plans

Cherry Servers offers various cloud VPS and bare metal plans:

- `cloud_vps_1` - 1 vCPU, 2GB RAM, 40GB SSD (default)
- `cloud_vps_2` - 2 vCPU, 4GB RAM, 80GB SSD
- `cloud_vps_3` - 4 vCPU, 8GB RAM, 160GB SSD
- Bare metal plans available through the API

View all plans: https://portal.cherryservers.com/

## Regions

Available regions:

- `eu_nord_1` - Lithuania (default)
- `eu_west_1` - Netherlands
- `us_east_1` - USA East Coast
- `us_west_1` - USA West Coast
- `ap_southeast_1` - Singapore

## Usage Examples

### OpenClaw on Cherry Servers

```bash
export CHERRY_AUTH_TOKEN="your-token"
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cherry/openclaw.sh)
```

### Goose on Cherry Servers

```bash
export CHERRY_AUTH_TOKEN="your-token"
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cherry/goose.sh)
```

### Custom configuration

```bash
export CHERRY_AUTH_TOKEN="your-token"
export CHERRY_DEFAULT_PLAN="cloud_vps_2"
export CHERRY_DEFAULT_REGION="us_east_1"
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cherry/openclaw.sh)
```

## How it works

1. **Authentication** - Validates `CHERRY_AUTH_TOKEN` with Cherry Servers API
2. **SSH Key** - Generates SSH key pair if needed and registers public key
3. **Project** - Fetches your default project ID from Cherry Servers account
4. **Provisioning** - Creates cloud VPS with specified plan, region, and image
5. **Connectivity** - Waits for SSH access and cloud-init completion
6. **Agent Setup** - Installs agent, injects OpenRouter credentials, launches interactive session

## API Documentation

- API Docs: https://api.cherryservers.com/doc/
- CLI (cherryctl): https://github.com/cherryservers/cherryctl
- Portal: https://portal.cherryservers.com/

## Pricing

Cherry Servers uses hourly billing with no long-term commitments. Prices vary by plan and region.

View current pricing: https://www.cherryservers.com/pricing

## Notes

- All Cherry Servers instances use `root` user for SSH access
- Servers are created with your registered SSH key automatically attached
- Full root access and IP-KVM available
- Cloud-init is supported for automated setup
- Servers can be managed via API, CLI (cherryctl), or web portal
