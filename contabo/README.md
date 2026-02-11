# Contabo

Contabo VPS and cloud servers via REST API with CLI support. [Contabo](https://contabo.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/contabo/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/contabo/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/contabo/goose.sh)
```

## Non-Interactive Mode

```bash
CONTABO_SERVER_NAME=dev-mk1 \
CONTABO_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/contabo/claude.sh)
```

## Environment Variables

- `CONTABO_API_TOKEN` - OAuth2 access token (required)
- `CONTABO_SERVER_NAME` - Server name (optional, will prompt if not set)
- `CONTABO_PRODUCT_ID` - Instance type (default: V92 = 3vCPUs, 8GB RAM)
- `CONTABO_REGION` - Region (default: EU, options: EU, US-central, US-east, US-west, SIN)
- `CONTABO_IMAGE_ID` - OS image (default: ubuntu-24.04)
- `CONTABO_PERIOD` - Contract period in months (default: 1)
- `OPENROUTER_API_KEY` - OpenRouter API key (optional, will use OAuth if not set)

## Getting Your API Token

1. Go to https://my.contabo.com/api/details
2. Click "New Credentials" if you don't have one
3. Save your Client ID and Client Secret
4. Get an access token:

```bash
curl -X POST 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'grant_type=client_credentials'
```

5. Extract the `access_token` from the response and set:

```bash
export CONTABO_API_TOKEN=your-access-token
```

## Pricing

Contabo offers powerful VPS plans starting under $5/month:

- **V92** (default): 3vCPUs, 8GB RAM, 150GB SSD - ~$5/month
- **V76**: 2vCPUs, 4GB RAM, 100GB SSD - ~$4/month
- Hourly billing available
- 12 locations across 9 global regions (EU, US, Asia, Australia)
- Unlimited traffic (fair usage policy)

## Notes

- Provisioning takes 2-5 minutes (longer than some other providers)
- SSH access via root user
- Cloud-init support for automatic setup
- Official CLI tool (cntb) available at https://github.com/contabo/cntb
- API documentation: https://api.contabo.com/
