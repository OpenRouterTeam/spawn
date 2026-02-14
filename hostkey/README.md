# HOSTKEY

HOSTKEY VPS hosting via REST API. [HOSTKEY](https://hostkey.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hostkey/claude.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hostkey/interpreter.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hostkey/gptme.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hostkey/openclaw.sh)
```

## Authentication

To use HOSTKEY spawn scripts, you need a HOSTKEY API key:

1. Log in to [HOSTKEY](https://hostkey.com/)
2. Navigate to API settings in your account
3. Generate a new API key
4. Set the `HOSTKEY_API_KEY` environment variable

## Non-Interactive Mode

```bash
HOSTKEY_SERVER_NAME=dev-mk1 \
HOSTKEY_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/hostkey/claude.sh)
```

## Environment Variables

- `HOSTKEY_API_KEY` - Your HOSTKEY API key (required)
- `HOSTKEY_SERVER_NAME` - Server name (prompted if not set)
- `HOSTKEY_LOCATION` - Data center location: `nl`, `de`, `fi`, `is`, `tr`, `us` (default: `nl`)
- `HOSTKEY_INSTANCE_PRESET` - Instance preset ID (default: `1`)
- `OPENROUTER_API_KEY` - Your OpenRouter API key (prompted via OAuth if not set)

## Pricing

HOSTKEY offers affordable VPS hosting starting from €1/month with hourly billing available. Check [HOSTKEY pricing](https://hostkey.com/vps/) for current rates.

## Locations

- `nl` - Amsterdam, Netherlands
- `de` - Frankfurt, Germany
- `fi` - Helsinki, Finland
- `is` - Reykjavik, Iceland
- `tr` - Istanbul, Turkey
- `us` - New York, United States
