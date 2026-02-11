# Contabo Cloud

Deploy AI agents on [Contabo](https://contabo.com/) - a budget-friendly European VPS provider with affordable CPU instances starting at $4.95/month.

## Why Contabo?

- **Budget-friendly**: VPS plans starting at $4.95/month
- **European provider**: Multiple European data centers (Germany, UK, etc.)
- **Full root access**: Complete control over your instances
- **REST API**: Full API support for automation
- **Cloud-init support**: Easy provisioning with user_data
- **Fast provisioning**: Instances typically ready in 2-5 minutes

## Prerequisites

### API Credentials

Get your API credentials from the [Contabo Customer Control Panel](https://my.contabo.com/api/details):

1. Log in to https://my.contabo.com
2. Navigate to API → API Details
3. Note down all 4 required values:
   - **Client ID**: OAuth2 client identifier
   - **Client Secret**: OAuth2 client secret
   - **API User**: Your API username (email)
   - **API Password**: Your API password

Set them as environment variables:

```bash
export CONTABO_CLIENT_ID="your_client_id"
export CONTABO_CLIENT_SECRET="your_client_secret"
export CONTABO_API_USER="your_api_user@example.com"
export CONTABO_API_PASSWORD="your_api_password"
```

Or the script will prompt you interactively and save them to `~/.config/spawn/contabo.json`.

### SSH Key

The scripts will automatically:
- Generate an SSH key at `~/.ssh/spawn_ed25519` (if it doesn't exist)
- Register it with Contabo as a secret
- Use it to access your instances

## Usage

### Deploy Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/contabo/claude.sh)
```

### Deploy Aider

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/contabo/aider.sh)
```

### Deploy OpenClaw

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/contabo/openclaw.sh)
```

## Environment Variables

### Required (if not set, you'll be prompted):

- `CONTABO_CLIENT_ID` - OAuth2 client ID from Contabo API details
- `CONTABO_CLIENT_SECRET` - OAuth2 client secret
- `CONTABO_API_USER` - API username (email address)
- `CONTABO_API_PASSWORD` - API password

### Optional:

- `CONTABO_SERVER_NAME` - Instance display name (default: prompt)
- `CONTABO_PRODUCT_ID` - VPS product ID (default: `V45` = 2 vCPU, 8GB RAM)
- `CONTABO_REGION` - Region code (default: `EU`)
- `CONTABO_IMAGE_ID` - OS image (default: `ubuntu-24.04`)
- `CONTABO_PERIOD` - Billing period in months (default: `1`)
- `OPENROUTER_API_KEY` - Your OpenRouter API key (or use OAuth)

### Common Product IDs

| Product ID | vCPUs | RAM   | Disk    | Price/month |
|------------|-------|-------|---------|-------------|
| V8         | 4     | 6 GB  | 50 GB   | ~$6.99      |
| V45        | 2     | 8 GB  | 100 GB  | ~$8.99      |
| V16        | 6     | 16 GB | 400 GB  | ~$14.99     |
| V32        | 8     | 30 GB | 800 GB  | ~$26.99     |

Check [Contabo VPS pricing](https://contabo.com/en/vps/) for current rates.

### Available Regions

- `EU` - European data centers (Germany, UK)
- `US-east` - US East Coast
- `US-central` - US Central
- `US-west` - US West Coast
- `SIN` - Singapore

## How It Works

1. **Authentication**: Uses OAuth2 password grant flow
   - Exchanges client credentials + user credentials for an access token
   - Token is cached for the session
   - API calls include `Authorization: Bearer <token>` header

2. **SSH Key Management**:
   - Registers your SSH public key as a Contabo secret
   - Includes the secret ID in instance creation request
   - Root access is enabled by default

3. **Instance Provisioning**:
   - Creates instance via `POST /v1/compute/instances`
   - Includes cloud-init userData for agent installation
   - Polls instance status until "running"
   - Extracts public IPv4 address

4. **Agent Setup**:
   - Waits for SSH connectivity
   - Waits for cloud-init to complete
   - Verifies agent installation (or installs manually)
   - Injects OpenRouter API key
   - Starts interactive session

## Pricing

Contabo offers **monthly billing** (not hourly):
- Minimum commitment: 1 month
- Billed monthly in advance
- No prorated refunds for early termination
- Unlimited traffic included

**Example costs:**
- VPS S (V45): 2 vCPU, 8GB RAM → ~$8.99/month
- VPS M (V16): 6 vCPU, 16GB RAM → ~$14.99/month

Check [current pricing](https://contabo.com/en/vps/) on their website.

## Troubleshooting

### Authentication Errors

If you see "Failed to obtain Contabo OAuth token":
1. Verify all 4 credentials are correct
2. Check API user has API access enabled
3. Ensure API password is set (not your login password)
4. Visit https://my.contabo.com/api/details to verify

### Instance Creation Fails

Common issues:
- **Insufficient balance**: Add funds to your account
- **Account limits**: Contact support to increase limits
- **Product unavailable**: Try different `CONTABO_PRODUCT_ID` or `CONTABO_REGION`

### SSH Connection Timeout

- Contabo instances can take 2-5 minutes to provision
- Check instance status in Customer Control Panel
- Verify SSH key was registered correctly
- Check firewall settings allow SSH (port 22)

### Cloud-init Not Completing

- Check `/var/log/cloud-init-output.log` on the instance
- Verify image supports cloud-init (default Ubuntu images do)
- May need to wait longer (use higher timeout)

## API Documentation

- Official API docs: https://api.contabo.com/
- Customer Control Panel: https://my.contabo.com/
- API Details: https://my.contabo.com/api/details

## Notes

- Contabo uses **monthly billing**, not hourly/per-second like many other clouds
- **Budget-friendly** but less flexible than pay-per-hour providers
- Good for **long-running development environments** or **stable workloads**
- **European data centers** make it GDPR-friendly
- **Full root access** on all VPS instances
- **Unlimited traffic** included in all plans
