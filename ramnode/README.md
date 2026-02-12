# RamNode Cloud

Budget VPS cloud provider with OpenStack API compatibility and hourly billing.

## Overview

- **Provider**: [RamNode](https://www.ramnode.com/)
- **Pricing**: Hourly billing starting at $0.006/hr (~$4.38/month for 1GB instance)
- **API**: Full OpenStack API compatibility
- **Billing**: Pay-as-you-go with $3 minimum cloud credit
- **Regions**: Multiple US and international locations

## Authentication

RamNode uses OpenStack authentication with username, password, and project ID.

### Getting Credentials

1. Go to [RamNode Cloud Control Panel](https://manage.ramnode.com/)
2. Navigate to: Cloud → API Users
3. Create or select an API user
4. Note your credentials:
   - **Username**: Your API username
   - **Password**: Your API password
   - **Project ID**: Your cloud project ID

### Setting Credentials

**Option 1: Environment Variables**
```bash
export RAMNODE_USERNAME="your-username"
export RAMNODE_PASSWORD="your-password"
export RAMNODE_PROJECT_ID="your-project-id"
```

**Option 2: Interactive Prompt**

If credentials are not set, the script will prompt for them and save to `~/.config/spawn/ramnode.json`.

## Usage

### Run Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/claude.sh)
```

### Run Aider

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/aider.sh)
```

### Run Goose

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/goose.sh)
```

### Run NanoClaw

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/ramnode/nanoclaw.sh)
```

## Configuration

### Environment Variables

- `RAMNODE_USERNAME` - Your RamNode API username
- `RAMNODE_PASSWORD` - Your RamNode API password
- `RAMNODE_PROJECT_ID` - Your cloud project ID
- `RAMNODE_SERVER_NAME` - Server name (optional, will prompt if not set)
- `RAMNODE_FLAVOR` - Instance flavor (optional, defaults to interactive picker)
- `OPENROUTER_API_KEY` - OpenRouter API key (optional, will use OAuth if not set)

### Instance Flavors

RamNode offers various instance sizes. Common options:
- **1GB** - 1 vCPU, 1GB RAM (~$0.006/hr)
- **2GB** - 1 vCPU, 2GB RAM (~$0.012/hr)
- **4GB** - 2 vCPU, 4GB RAM (~$0.024/hr)

The script will show available flavors interactively if `RAMNODE_FLAVOR` is not set.

## Features

- ✅ Full OpenStack API compatibility
- ✅ Hourly billing (billed by the second)
- ✅ SSH key management via API
- ✅ Cloud-init support for automated setup
- ✅ Multiple instance sizes
- ✅ Low minimum cost ($3 cloud credit)

## Pricing

RamNode uses hourly billing with per-second granularity:

- **1GB instance**: ~$0.006/hr = ~$4.38/month
- **2GB instance**: ~$0.012/hr = ~$8.76/month
- **4GB instance**: ~$0.024/hr = ~$17.52/month

Billing is deducted from your cloud credit balance. Minimum deposit: $3.

## Technical Details

### API Endpoints

- **Identity**: `https://openstack.ramnode.com:5000/v3`
- **Compute**: `https://openstack.ramnode.com:8774/v2.1`
- **Network**: `https://openstack.ramnode.com:9696/v2.0`

### Authentication

RamNode uses OpenStack Keystone v3 authentication with password grant:
1. POST to `/v3/auth/tokens` with username/password/project
2. Receive `X-Subject-Token` header
3. Use token in subsequent API calls

### Server Creation

Uses OpenStack Compute API:
- Creates server with Ubuntu 24.04 image
- Injects cloud-init via `user_data` (base64 encoded)
- Attaches SSH key for root access
- Waits for IPv4 address assignment

## Troubleshooting

### Insufficient Cloud Credit

**Error**: "Insufficient cloud credit"

**Fix**: Add at least $3 in cloud credit through the [RamNode Client Area](https://manage.ramnode.com/).

### Authentication Failed

**Error**: "Authentication failed"

**Fix**: Verify credentials at Cloud Control Panel → API Users. Ensure username, password, and project ID are correct.

### SSH Connection Timeout

**Error**: "SSH connectivity check failed"

**Fix**: Wait a few minutes for the server to fully boot and configure cloud-init. If the issue persists, check that your SSH key was properly registered.

## Implemented Agents

- ✅ Claude Code
- ✅ Aider
- ✅ Goose
- ✅ Open Interpreter
- ✅ NanoClaw
- ✅ OpenClaw
- ✅ Cline
- ✅ gptme
- ✅ Continue

## Documentation

- [RamNode Documentation](https://www.ramnode.com/docs/)
- [OpenStack API Documentation](https://docs.openstack.org/api-quick-start/)
- [Cloud Control Panel](https://manage.ramnode.com/)
