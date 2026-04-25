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

#### Junie

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/junie.sh)
```

#### Cursor CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/cursor.sh)
```

#### Pi

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/pi.sh)
```

#### T3 Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/t3code.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DIGITALOCEAN_ACCESS_TOKEN` | DigitalOcean API token (also accepts `DIGITALOCEAN_API_TOKEN` or `DO_API_TOKEN`) | — (OAuth if unset) |
| `DO_DROPLET_NAME` | Name for the created droplet | auto-generated |
| `DO_REGION` | Datacenter region (see regions below) | `nyc3` |
| `DO_DROPLET_SIZE` | Droplet size slug (see sizes below) | `s-2vcpu-2gb` |
| `SPAWN_JSON_READINESS` | Set to `1` with `SPAWN_NON_INTERACTIVE=1` to print machine-readable JSON when readiness is blocked | — |
| `SPAWN_CLI_DIR` | Absolute path to the Spawn repo root when developing locally — makes the cloud shim run `packages/cli/src/{cloud}/main.ts` instead of downloading a release bundle | — |

### Pre-flight readiness

Before region/size selection, the CLI checks DigitalOcean account state (`GET /v2/account`), SSH keys registered on your account, and OpenRouter credentials. If something blocks deployment (unverified email, locked or warning billing status, droplet quota, missing SSH registration, or invalid OpenRouter key), you get guided steps and a readiness checklist. Billing issues open the add-payment flow: `https://cloud.digitalocean.com/account/billing?defer-onboarding-for=or&open-add-payment-method=true`.

OAuth tokens requested by the CLI include `tag:create` so droplets can be tagged `spawn` for attribution. If your token cannot create tags, the CLI retries creation without the tag.

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
| `s-2vcpu-2gb` | 2 vCPU · 2 GB RAM | $18/mo (default) |
| `s-2vcpu-4gb` | 2 vCPU · 4 GB RAM | $24/mo |
| `s-4vcpu-8gb` | 4 vCPU · 8 GB RAM | $48/mo |
| `s-8vcpu-16gb` | 8 vCPU · 16 GB RAM | $96/mo |

## Non-Interactive Mode

```bash
DO_DROPLET_NAME=dev-mk1 \
DIGITALOCEAN_ACCESS_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh)
```

Override region and droplet size:

```bash
DO_REGION=fra1 \
DO_DROPLET_SIZE=s-1vcpu-2gb \
DIGITALOCEAN_ACCESS_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh)
```

## Interactive Region and Size Picker

Pass `--custom` to select from a menu of regions and droplet sizes interactively:

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/digitalocean/claude.sh) --custom
```
