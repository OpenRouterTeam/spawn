# IONOS Cloud

IONOS Cloud is a budget-friendly European cloud provider offering VPS and cloud servers with flexible minute-based billing.

## Features

- **Ultra-cheap pricing**: Starting at $2/month for basic VPS (1 vCore, 1GB RAM, 10GB SSD)
- **Minute-based billing**: Pay only for what you use with Cloud Cubes
- **REST API**: Full CloudAPI v6 for programmatic control
- **Global locations**: Multiple datacenters across US and Europe
- **Root SSH access**: Full control over your servers
- **Unlimited traffic**: No bandwidth overage charges on Cloud VPS plans

## Authentication

IONOS Cloud uses Basic Authentication with your account credentials:

1. Go to [IONOS Data Center Designer (DCD)](https://dcd.ionos.com/)
2. Navigate to **Management → Users & Keys**
3. Create or retrieve your API credentials:
   - **Username**: Your IONOS account email
   - **Password**: Your API password/key

Set these as environment variables:

```bash
export IONOS_USERNAME="your-email@example.com"
export IONOS_PASSWORD="your-api-password"
```

Alternatively, spawn will prompt for them on first use and save to `~/.config/spawn/ionos.json`.

## Configuration

### Environment Variables

- `IONOS_USERNAME` (required): Your IONOS account email
- `IONOS_PASSWORD` (required): Your IONOS API password/key
- `IONOS_SERVER_NAME` (optional): Server name (will prompt if not set)
- `IONOS_CORES` (default: 2): Number of CPU cores
- `IONOS_RAM` (default: 2048): RAM in MB
- `IONOS_DISK_SIZE` (default: 20): Boot disk size in GB
- `IONOS_LOCATION` (default: us/las): Datacenter location

### Available Locations

- **US**: `us/las` (Las Vegas), `us/ewr` (Newark)
- **Europe**: `de/fra` (Frankfurt), `de/fkb` (Karlsruhe), `gb/lhr` (London)

## Usage

```bash
# Run Claude Code on IONOS Cloud
spawn claude ionos

# Run with custom resources
IONOS_CORES=4 IONOS_RAM=4096 spawn claude ionos

# Run Aider
spawn aider ionos

# Run Goose
spawn goose ionos
```

## Pricing

IONOS offers two main compute options:

### Cloud VPS (Fixed monthly plans)
- **Basic**: $2/month - 1 vCore, 1GB RAM, 10GB SSD, unlimited traffic
- **Standard**: $5/month - 2 vCores, 2GB RAM, 80GB SSD, unlimited traffic

### Cloud Cubes (Flexible pay-as-you-go)
- Minute-based billing
- Scale resources on demand
- Perfect for short-lived AI agent sessions

Spawn creates servers in the Cloud Cubes model by default for maximum flexibility.

## Notes

- **Datacenter Management**: IONOS organizes resources into "datacenters" (logical containers). Spawn will create one automatically if you don't have any.
- **Provisioning Time**: Initial datacenter + server creation can take 3-5 minutes. Subsequent servers in the same datacenter provision faster (~2 minutes).
- **SSH Keys**: SSH keys are registered per-datacenter. Spawn handles this automatically.
- **Cloud-init Support**: Full cloud-init support via `userData` in volume creation.
- **Volume-based Boot**: Servers boot from volumes (similar to AWS EBS). The boot volume is created first, then attached to the server.

## API Reference

- [IONOS Cloud API v6 Documentation](https://api.ionos.com/docs/cloud/v6/)
- [DCD (Data Center Designer)](https://dcd.ionos.com/)
- [IONOS Cloud Console](https://cloud.ionos.com/)

## Implemented Agents

- ✅ Claude Code (`ionos/claude.sh`)
- ✅ Aider (`ionos/aider.sh`)
- ✅ Goose (`ionos/goose.sh`)

See `manifest.json` for the full list of implemented and missing agents.
