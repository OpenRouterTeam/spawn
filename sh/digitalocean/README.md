# DigitalOcean

DigitalOcean Droplets via REST API. [DigitalOcean](https://www.digitalocean.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/kilocode.sh)
```

#### Hermes

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/hermes.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DO_API_TOKEN` | DigitalOcean API token | — (OAuth if unset) |
| `DO_DROPLET_NAME` | Name for the created droplet | auto-generated |
| `DO_REGION` | Datacenter region (see regions below) | `nyc3` |
| `DO_DROPLET_SIZE` | Droplet size slug (see sizes below) | `s-2vcpu-4gb` |

### Available Regions

| Slug | Location |
|---|---|
| `nyc1` | New York 1 |
| `nyc3` | New York 3 (default) |
| `sfo3` | San Francisco 3 |
| `ams3` | Amsterdam 3 |
| `sgp1` | Singapore 1 |
| `lon1` | London 1 |
| `fra1` | Frankfurt 1 |
| `tor1` | Toronto 1 |
| `blr1` | Bangalore 1 |
| `syd1` | Sydney 1 |

### Available Droplet Sizes

| Slug | Specs | Price |
|---|---|---|
| `s-1vcpu-1gb` | 1 vCPU · 1 GB RAM | $6/mo |
| `s-1vcpu-2gb` | 1 vCPU · 2 GB RAM | $12/mo |
| `s-2vcpu-2gb` | 2 vCPU · 2 GB RAM | $18/mo |
| `s-2vcpu-4gb` | 2 vCPU · 4 GB RAM | $24/mo (default) |
| `s-4vcpu-8gb` | 4 vCPU · 8 GB RAM | $48/mo |
| `s-8vcpu-16gb` | 8 vCPU · 16 GB RAM | $96/mo |

## Non-Interactive Mode

```bash
DO_DROPLET_NAME=dev-mk1 \
DO_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh)
```

Override region and droplet size:

```bash
DO_REGION=fra1 \
DO_DROPLET_SIZE=s-1vcpu-2gb \
DO_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh)
```

## Interactive Region and Size Picker

Pass `--custom` to select from a menu of regions and droplet sizes interactively:

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh) --custom
```
