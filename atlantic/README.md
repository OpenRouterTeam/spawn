# Atlantic.Net Cloud - Spawn Scripts

Deploy AI agents on [Atlantic.Net Cloud](https://www.atlantic.net/) VPS instances with hourly billing starting at $0.0119/hr ($8/mo).

## Features

- **Budget-friendly**: Hourly billing with monthly cap (672 hours)
- **REST API**: Full API for programmatic server management
- **SSH Access**: Root access via SSH with key management
- **Fast Provisioning**: Typically under 2 minutes from API call to SSH ready
- **Global Locations**: Multiple datacenters across US, Canada, Europe

## Prerequisites

- **Atlantic.Net Account**: Sign up at [atlantic.net](https://www.atlantic.net/)
- **API Credentials**: Get from Control Panel → Account → API Info
  - Access Key ID (format: `Atl...`)
  - Private Key (secret)

## Authentication

The scripts support three methods (in priority order):

1. **Environment variables** (recommended for automation):
   ```bash
   export ATLANTIC_API_ACCESS_KEY="Atl8adf4202f9e44vcha2af611f42f84a08"
   export ATLANTIC_API_PRIVATE_KEY="your-private-key-here"
   ```

2. **Config file**: `~/.config/spawn/atlantic.json`
   ```json
   {
     "access_key": "Atl8adf4202f9e44vcha2af611f42f84a08",
     "private_key": "your-private-key-here"
   }
   ```

3. **Interactive prompt**: Script will prompt and save credentials if not found

## Configuration

All scripts support these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ATLANTIC_SERVER_NAME` | Prompt | Server hostname |
| `ATLANTIC_PLAN` | `G2.2GB` | Server plan/size |
| `ATLANTIC_LOCATION` | `USEAST2` | Datacenter location |
| `ATLANTIC_IMAGE` | `ubuntu-24.04-x64` | OS image |
| `OPENROUTER_API_KEY` | OAuth flow | OpenRouter API key for agents |

### Available Plans

Common plans (hourly rates based on $8-32/mo range):
- `G2.2GB` - 1 vCPU, 2GB RAM, 50GB SSD (~$0.0119/hr)
- `G2.4GB` - 2 vCPU, 4GB RAM, 80GB SSD (~$0.0238/hr)
- `G2.8GB` - 4 vCPU, 8GB RAM, 160GB SSD (~$0.0476/hr)

See all plans: [Atlantic.Net VPS Pricing](https://www.atlantic.net/vps-hosting/)

### Available Locations

Common locations:
- `USEAST1` - Orlando, FL
- `USEAST2` - New York, NY
- `USCENTRAL1` - Dallas, TX
- `USWEST1` - San Francisco, CA
- `CAEAST1` - Toronto, Canada
- `EUWEST1` - London, UK

## Usage Examples

### Claude Code

```bash
# With env vars
export ATLANTIC_API_ACCESS_KEY="Atl..."
export ATLANTIC_API_PRIVATE_KEY="your-key"
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/atlantic/claude.sh)

# Or let it prompt for credentials
bash atlantic/claude.sh
```

### Aider

```bash
export ATLANTIC_API_ACCESS_KEY="Atl..."
export ATLANTIC_API_PRIVATE_KEY="your-key"
export MODEL_ID="anthropic/claude-3.5-sonnet"
bash atlantic/aider.sh
```

### OpenClaw

```bash
export ATLANTIC_API_ACCESS_KEY="Atl..."
export ATLANTIC_API_PRIVATE_KEY="your-key"
bash atlantic/openclaw.sh
```

### Custom Configuration

```bash
export ATLANTIC_API_ACCESS_KEY="Atl..."
export ATLANTIC_API_PRIVATE_KEY="your-key"
export ATLANTIC_PLAN="G2.4GB"
export ATLANTIC_LOCATION="USWEST1"
export ATLANTIC_SERVER_NAME="my-ai-server"
bash atlantic/claude.sh
```

## API Reference

The `atlantic/lib/common.sh` library provides these key functions:

### Authentication
- `ensure_atlantic_credentials` - Get/validate API credentials
- `atlantic_api <action> [params]` - Make signed API calls
- `test_atlantic_credentials` - Validate credentials

### SSH Key Management
- `ensure_ssh_key` - Generate and register SSH keys
- `atlantic_check_ssh_key <fingerprint>` - Check if key is registered
- `atlantic_register_ssh_key <name> <path>` - Register new SSH key

### Server Management
- `create_server <name>` - Provision new cloud server
- `verify_server_connectivity <ip>` - Wait for SSH access
- `run_server <ip> <command>` - Execute command via SSH
- `upload_file <ip> <local> <remote>` - Upload file via SCP
- `interactive_session <ip> [command]` - Start interactive SSH session
- `destroy_server <instance_id>` - Terminate server

### Server Information
- `atlantic_list_images` - Get available OS images
- `atlantic_list_plans` - Get available server plans
- `atlantic_list_locations` - Get available datacenters

## Authentication Details

Atlantic.Net uses HMAC-SHA256 signature authentication:

1. Generate random GUID (UUID v4)
2. Get current Unix timestamp
3. Concatenate: `timestamp + guid`
4. Sign with HMAC-SHA256 using private key
5. Base64 encode and URL encode the signature
6. Include in API request: `ACSAccessKeyId`, `Timestamp`, `Rndguid`, `Signature`

The library handles this automatically via `atlantic_generate_signature()`.

## Billing

- **Hourly billing** with monthly cap (672 hours = 28 days)
- **Pay-as-you-go**: Only pay for hours used
- **No setup fees** or hidden charges
- **Monthly cap**: After 672 hours, no additional charges for the month

Example: A `G2.2GB` server ($0.0119/hr) costs:
- 24 hours: $0.29
- 7 days: $2.02
- Full month: $8.00 (capped)

## Troubleshooting

### Authentication Errors

```
ERROR: API Error: Invalid credentials or API error
```

**Fix**:
1. Verify credentials at Control Panel → Account → API Info
2. Ensure Access Key ID starts with `Atl`
3. Check Private Key is correct (no extra spaces/newlines)
4. Delete `~/.config/spawn/atlantic.json` and re-enter credentials

### SSH Connection Timeout

```
ERROR: SSH connection to <IP> failed after 300 seconds
```

**Fix**:
1. Check server status in Atlantic.Net Control Panel
2. Verify SSH key was registered: `atlantic_api list-sshkeys`
3. Ensure port 22 is open (default firewall allows SSH)
4. Try manual SSH: `ssh -i ~/.ssh/spawn_ed25519 root@<IP>`

### Server Creation Failed

```
ERROR: Failed to create server
```

**Fix**:
1. Verify account has sufficient credit/billing enabled
2. Check plan name is valid: `atlantic_api list-plans`
3. Check location code is valid: `atlantic_api list-locations`
4. Ensure image ID exists: `atlantic_api list-images`

## API Documentation

Official documentation: [Atlantic.Net API Reference](https://www.atlantic.net/docs/api/)

Key endpoints used:
- `POST /?Action=run-instance` - Create server
- `POST /?Action=list-sshkeys` - List SSH keys
- `POST /?Action=add-sshkey` - Register SSH key
- `POST /?Action=terminate-instance` - Destroy server
- `POST /?Action=list-images` - Get OS images
- `POST /?Action=list-plans` - Get server plans
- `POST /?Action=list-locations` - Get datacenters

## Implementation Details

- **Default user**: `root`
- **SSH key type**: Ed25519 (`~/.ssh/spawn_ed25519`)
- **Cloud-init**: Injected via user data during server creation
- **Provisioning time**: ~90-120 seconds average
- **curl|bash compatible**: All scripts work with remote execution

## Security Notes

1. **Credentials**: Store in `~/.config/spawn/atlantic.json` (chmod 600)
2. **SSH keys**: Use Ed25519 keys, never share private keys
3. **API rate limits**: 60 requests/minute per access key + IP
4. **HTTPS only**: All API calls use TLS
5. **Signature-based auth**: Prevents replay attacks via timestamp + GUID
