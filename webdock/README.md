# Webdock

Webdock is a European VPS provider offering affordable cloud servers with API access.

## Features

- **REST API**: Full-featured API for server management
- **Affordable pricing**: Starting from €2.15/month (Intel Xeon) or €4.30/month (AMD EPYC)
- **Multiple locations**: Data centers in Europe (Finland, Netherlands, UK)
- **Developer-friendly**: Free API, automated backups, free SSL, 1-click deployments
- **SSH access**: Full root SSH access to all servers
- **GDPR compliant**: European data protection standards

## Authentication

Set your Webdock API token as an environment variable:

```bash
export WEBDOCK_API_TOKEN="your-api-token-here"
```

To obtain an API token:
1. Log in to [https://my.webdock.io](https://my.webdock.io)
2. Go to Account Area > API & Integrations
3. Generate a new API key

The token will be automatically saved to `~/.config/spawn/webdock.json` for future use.

## Usage

Launch Claude Code on a Webdock server:

```bash
bash webdock/claude.sh
```

Or use the CLI:

```bash
spawn run webdock claude
```

## Available Scripts

- `claude.sh` — Claude Code (Anthropic's CLI coding agent)
- `cline.sh` — Cline (AI pair programming in your editor)
- `aider.sh` — Aider (AI pair programming in the terminal)

## Configuration

### Server Profile

Set the server profile (hardware tier) via environment variable:

```bash
export WEBDOCK_PROFILE="webdockmicro"  # Default
```

Available profiles:
- `webdockmicro` — 1 vCPU, 1GB RAM, 25GB SSD (€2.15-4.30/mo)
- `webdocksmall` — 1 vCPU, 2GB RAM, 50GB SSD
- `webdockmedium` — 2 vCPU, 4GB RAM, 80GB SSD
- `webdocklarge` — 4 vCPU, 8GB RAM, 160GB SSD
- `webdockxl` — 6 vCPU, 16GB RAM, 320GB SSD

Check [Webdock pricing](https://webdock.io/en/pricing) for the full list and current prices.

### Location

Set the server location via environment variable:

```bash
export WEBDOCK_LOCATION="fi"  # Default (Finland)
```

Available locations:
- `fi` — Finland (Helsinki)
- `nl` — Netherlands (Amsterdam)
- `uk` — United Kingdom (London)

### Image

Set the OS image via environment variable:

```bash
export WEBDOCK_IMAGE="ubuntu2404"  # Default
```

Available images include Ubuntu, Debian, and various pre-configured stacks (LEMP, WordPress, etc.).
Check the Webdock control panel for the full list of available images.

### Server Name

Set a custom server name:

```bash
export WEBDOCK_SERVER_NAME="my-ai-server"
```

If not set, you'll be prompted to enter one.

## How It Works

1. **Authenticate**: Validates your API token with Webdock
2. **SSH Key**: Ensures your SSH key is registered (generates ed25519 key if needed)
3. **Provision**: Creates a new server with the specified profile, location, and image
4. **Wait**: Polls until the server is online and SSH-ready
5. **Setup**: Installs the agent and configures OpenRouter API credentials
6. **Launch**: Drops you into an interactive session with the agent

## Cleanup

Servers persist after the script exits. To destroy a server:

```bash
# Using the Webdock API
curl -X DELETE "https://api.webdock.io/v1/servers/SERVER_SLUG" \
  -H "Authorization: Bearer $WEBDOCK_API_TOKEN"
```

Or delete from the Webdock control panel: https://my.webdock.io/servers

## Limitations

- Webdock is primarily European-focused (data centers in EU only)
- Profile availability may vary by location
- Server creation can take 1-3 minutes depending on load

## Links

- Website: https://webdock.io
- API Documentation: https://api.webdock.io/v1
- Control Panel: https://my.webdock.io
- Pricing: https://webdock.io/en/pricing
