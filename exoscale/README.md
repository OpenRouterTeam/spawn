# Exoscale

Exoscale European cloud compute via CLI with per-second billing. [Exoscale](https://www.exoscale.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/exoscale/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/exoscale/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/exoscale/goose.sh)
```

## Non-Interactive Mode

```bash
EXOSCALE_SERVER_NAME=dev-mk1 \
EXOSCALE_API_KEY=your-key \
EXOSCALE_API_SECRET=your-secret \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/exoscale/claude.sh)
```

## Environment Variables

- `EXOSCALE_SERVER_NAME` - Name for the instance (optional, will prompt if not provided)
- `EXOSCALE_API_KEY` - Exoscale API key (required)
- `EXOSCALE_API_SECRET` - Exoscale API secret (required)
- `EXOSCALE_INSTANCE_TYPE` - Instance type (default: `standard.small`)
- `EXOSCALE_ZONE` - Zone (default: `ch-gva-2`)
- `EXOSCALE_TEMPLATE` - OS template (default: `Linux Ubuntu 24.04 LTS 64-bit`)
- `OPENROUTER_API_KEY` - OpenRouter API key (optional, will use OAuth if not provided)

## Getting Started

1. Create API credentials at https://portal.exoscale.com/iam/api-keys
2. Run one of the agent scripts above
3. The script will auto-install the exo CLI if needed
4. Configure your API credentials when prompted
5. The instance will be provisioned and the agent will start

## Available Zones

- `ch-gva-2` - Geneva, Switzerland (default)
- `ch-dk-2` - Zurich, Switzerland
- `de-fra-1` - Frankfurt, Germany
- `de-muc-1` - Munich, Germany
- `at-vie-1` - Vienna, Austria
- `at-vie-2` - Vienna, Austria
- `bg-sof-1` - Sofia, Bulgaria

## Pricing

Exoscale uses per-second billing with no upfront costs or long-term commitments. Resources are billed by the second at a flat rate across all zones.
