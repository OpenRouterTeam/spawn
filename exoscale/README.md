# Exoscale

Exoscale compute instances via exo CLI. [Exoscale](https://www.exoscale.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/exoscale/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/exoscale/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/exoscale/goose.sh)
```

## Non-Interactive Mode

```bash
EXOSCALE_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/exoscale/claude.sh)
```

## Environment Variables

- `EXOSCALE_INSTANCE_NAME` - Name for the instance (prompted if not set)
- `EXOSCALE_ZONE` - Exoscale zone (default: ch-gva-2)
- `EXOSCALE_INSTANCE_TYPE` - Instance type (default: standard.small)
- `OPENROUTER_API_KEY` - OpenRouter API key (OAuth flow if not set)

## Prerequisites

The script will automatically install and configure the Exoscale CLI (`exo`) if not found. You'll need:

1. An Exoscale account - [Sign up](https://portal.exoscale.com/register)
2. API credentials - Create at [https://portal.exoscale.com/iam/api-keys](https://portal.exoscale.com/iam/api-keys)

## Pricing

Exoscale offers per-second billing. Example pricing for standard.small:
- ~$0.01/hour (varies by zone)
- Billed per second for actual usage

Check current pricing at [https://www.exoscale.com/pricing/](https://www.exoscale.com/pricing/)
