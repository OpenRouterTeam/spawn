# CloudSigma

Run AI agents on CloudSigma's flexible cloud infrastructure.

## Quick Start

```bash
# Install spawn CLI
curl -fsSL https://spawn.sh | bash

# Run Claude Code on CloudSigma
spawn run cloudsigma/claude

# Or via direct script (one-liner)
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cloudsigma/claude.sh)
```

## Authentication

CloudSigma uses HTTP Basic Auth with email + password. The scripts will prompt you for credentials, or you can set them via environment variables:

```bash
export CLOUDSIGMA_EMAIL="your@email.com"
export CLOUDSIGMA_PASSWORD="your-password"
```

Credentials are saved to `~/.config/spawn/cloudsigma.json` for future use.

Get your credentials at: [CloudSigma Cloud Portal](https://zrh.cloudsigma.com/) (or wdc.cloudsigma.com / lvs.cloudsigma.com depending on region)

## Available Agents

- `cloudsigma/claude` — Claude Code (Anthropic's CLI agent)
- `cloudsigma/aider` — Aider (AI pair programming)

More coming soon! See `manifest.json` for the full matrix.

## Configuration

### Environment Variables

- `CLOUDSIGMA_EMAIL` — Your CloudSigma account email (required)
- `CLOUDSIGMA_PASSWORD` — Your CloudSigma account password (required)
- `CLOUDSIGMA_REGION` — Region code (default: `zrh`)
  - `zrh` — Zurich, Switzerland
  - `wdc` — Washington DC, USA
  - `lvs` — Las Vegas, USA
- `CLOUDSIGMA_CPU_MHZ` — CPU allocation in MHz (default: `1000` = 1 GHz)
- `CLOUDSIGMA_MEMORY_GB` — Memory in GB (default: `2`)
- `CLOUDSIGMA_DISK_SIZE_GB` — Disk size in GB (default: `20`)
- `CLOUDSIGMA_SERVER_NAME` — Custom server name (default: prompts interactively)
- `OPENROUTER_API_KEY` — OpenRouter API key (prompts via OAuth if not set)

### Example: Custom Configuration

```bash
# Create a larger instance in Washington DC
export CLOUDSIGMA_REGION="wdc"
export CLOUDSIGMA_CPU_MHZ="2000"
export CLOUDSIGMA_MEMORY_GB="4"
export CLOUDSIGMA_DISK_SIZE_GB="40"

spawn run cloudsigma/claude
```

## Pricing

CloudSigma uses pay-as-you-go pricing with granular resource control. You only pay for the CPU, memory, and disk you allocate.

Example costs (as of 2026):
- Small instance (1 GHz CPU, 2GB RAM, 20GB SSD): ~$14/month
- Pricing varies by region and resource allocation

See [CloudSigma Pricing](https://www.cloudsigma.com/pricing/) for current rates.

## Architecture

CloudSigma is an API-first cloud platform with:
- **Granular resource control** — Configure CPU, RAM, and disk independently
- **Multiple regions** — ZRH (Zurich), WDC (Washington DC), LVS (Las Vegas)
- **API v2.0** — RESTful API with HTTP Basic Auth
- **Ubuntu 24.04** — Cloned from CloudSigma's public library images
- **SSH access** — Uses `cloudsigma` user (automatically configured via SSH key injection)

## How It Works

1. **Authentication** — Validates CloudSigma credentials via `/balance/` endpoint
2. **SSH key registration** — Uploads your `~/.ssh/id_ed25519.pub` to CloudSigma keypairs
3. **Drive creation** — Clones Ubuntu 24.04 from public library drives
4. **Server creation** — Creates a KVM server with specified CPU/RAM, attaches the drive
5. **Server start** — Powers on the server and waits for IP assignment
6. **Cloud-init** — Waits for Ubuntu's cloud-init to complete
7. **Agent installation** — Installs the selected agent (Claude Code, Aider, etc.)
8. **OpenRouter injection** — Configures API keys via environment variables
9. **Interactive session** — Drops you into SSH with the agent running

## Troubleshooting

### "Could not find Ubuntu 24.04 image"
CloudSigma library drives are region-specific. Ensure you're using a region where Ubuntu 24.04 is available (zrh, wdc, lvs all have it).

### "Authentication failed"
- Verify email/password at your region's portal (e.g., https://zrh.cloudsigma.com/)
- Check that your account is active and not suspended
- Ensure you're using the correct region (`CLOUDSIGMA_REGION`)

### "Server did not become ready"
CloudSigma servers typically start in 30-60 seconds. If timeout occurs:
- Check your account balance (insufficient funds can prevent server start)
- Try a different region
- Verify resource quotas in your CloudSigma dashboard

## Implementation Notes

- **User**: CloudSigma uses the `cloudsigma` user for SSH (not `root` or `ubuntu`)
- **API Version**: v2.0 (`https://{region}.cloudsigma.com/api/2.0/`)
- **Auth**: HTTP Basic Auth (Base64-encoded `email:password`)
- **Drive cloning**: Each server gets a fresh Ubuntu 24.04 clone (not shared)
- **Networking**: DHCP-based IPv4 with virtio NIC model
- **VNC**: Available via CloudSigma portal (password: `spawn123`)

## Resources

- [CloudSigma API Docs](https://docs.cloudsigma.com/)
- [CloudSigma Pricing](https://www.cloudsigma.com/pricing/)
- [CloudSigma Regions](https://www.cloudsigma.com/cloud-locations/)
- [Spawn Repository](https://github.com/OpenRouterTeam/spawn)
