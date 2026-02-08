# UpCloud

UpCloud Cloud Servers via REST API. [UpCloud](https://upcloud.com/)

## Authentication

UpCloud uses HTTP Basic authentication with API credentials. Get your API credentials at:
[https://hub.upcloud.com/people/account](https://hub.upcloud.com/people/account) → API → Subaccounts

Create a subaccount with API access enabled and use the username:password for authentication.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/upcloud/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/upcloud/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/upcloud/aider.sh)
```

## Non-Interactive Mode

```bash
UPCLOUD_SERVER_NAME=dev-mk1 \
UPCLOUD_USERNAME=your-api-username \
UPCLOUD_PASSWORD=your-api-password \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/upcloud/claude.sh)
```

## Environment Variables

- `UPCLOUD_USERNAME`: API username (required)
- `UPCLOUD_PASSWORD`: API password (required)
- `UPCLOUD_SERVER_NAME`: Server hostname (optional, will prompt if not set)
- `UPCLOUD_PLAN`: Server plan (default: `1xCPU-2GB`)
- `UPCLOUD_ZONE`: Deployment zone (default: `us-nyc1`)
- `UPCLOUD_STORAGE_SIZE`: Storage size in GB (default: `50`)
- `OPENROUTER_API_KEY`: OpenRouter API key (optional, OAuth flow if not set)

## Available Zones

UpCloud has 13 global locations:

**North America:**
- `us-nyc1` (New York)
- `us-chi1` (Chicago)
- `us-sjo1` (San Jose)

**Europe:**
- `fi-hel1` (Helsinki)
- `uk-lon1` (London)
- `de-fra1` (Frankfurt)
- `nl-ams1` (Amsterdam)
- `es-mad1` (Madrid)
- `pl-waw1` (Warsaw)

**Asia:**
- `sg-sin1` (Singapore)
- `au-syd1` (Sydney)

## Available Plans

- `1xCPU-2GB` (default)
- `2xCPU-4GB`
- `4xCPU-8GB`
- Custom plans available (freely scalable CPU/memory)

## Pricing

- Billed hourly, capped at 672 hours/month
- Pay-per-hour model with predictable monthly costs
- Example: `1xCPU-2GB` ~$0.01-0.02/hour (~$7-14/month)
- Storage priced separately per GB

## Notes

- European cloud provider with global presence
- Cloud-init enabled templates support
- Free custom plans with scalable resources
- SSH key authentication built-in
- MaxIOPS storage tier for performance
- API updated January 2026
