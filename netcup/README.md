# Netcup Cloud

Netcup VPS cloud via REST API. [Netcup](https://www.netcup.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/goose.sh)
```

#### Amazon Q

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/amazonq.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/plandex.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/kilocode.sh)
```

## Non-Interactive Mode

```bash
NETCUP_SERVER_NAME=dev-mk1 \
NETCUP_CUSTOMER_NUMBER=12345 \
NETCUP_API_KEY=your-api-key \
NETCUP_API_PASSWORD=your-api-password \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/netcup/claude.sh)
```

## Authentication

Netcup uses session-based REST API authentication with three credentials:

1. **NETCUP_CUSTOMER_NUMBER** - Your customer number
2. **NETCUP_API_KEY** - API key from SCP
3. **NETCUP_API_PASSWORD** - API password from SCP

Get your credentials:
- Log in to [Netcup Server Control Panel](https://ccp.netcup.net/)
- Navigate to **Settings → API**
- Create a new API key if needed

The scripts will:
1. Check for credentials in environment variables
2. Check `~/.config/spawn/netcup.json`
3. Prompt for credentials if not found
4. Save credentials to config file for reuse

## Pricing

Budget VPS provider starting at approximately €3.86/month for entry-level VPS plans. Netcup offers flexible pricing with hourly billing or annual contracts.

## API

Netcup's REST API launched in October 2025. It uses session-based authentication (login to get session ID, then use session ID for API calls). The API replaces the legacy SOAP web service (discontinued May 1, 2026).

API documentation is available in the Server Control Panel → REST API Docs.
