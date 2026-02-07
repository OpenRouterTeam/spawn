# Spawn

Conjure your agents!

## Features

- 🔐 **Automatic OAuth** - Seamless authentication with OpenRouter
- 🔄 **Smart Fallback** - Manual API key entry if OAuth fails
- 🚀 **One Command Setup** - Get running in minutes
- 🔧 **Environment Ready** - Pre-configured shell and dependencies

## Usage

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/nanoclaw.sh)
```

### Non-Interactive Mode

For automation or CI/CD, set environment variables:

#### Claude Code

```bash
SPRITE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/claude.sh)
```

#### OpenClaw

```bash
SPRITE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/openclaw.sh)
```

#### NanoClaw

```bash
SPRITE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/nanoclaw.sh)
```

**Environment Variables:**
- `SPRITE_NAME` - Name for the sprite (skips prompt)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly

---

## Hetzner Cloud

Spawn agents on [Hetzner Cloud](https://www.hetzner.com/cloud/) servers. No `hcloud` CLI needed — uses the Hetzner REST API directly.

### Usage

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/nanoclaw.sh)
```

### Non-Interactive Mode

```bash
HETZNER_SERVER_NAME=dev-mk1 \
HCLOUD_TOKEN=your-hetzner-api-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/claude.sh)
```

**Environment Variables:**
- `HETZNER_SERVER_NAME` - Name for the server (skips prompt)
- `HCLOUD_TOKEN` - Hetzner Cloud API token (skips prompt, saved to `~/.config/spawn/hetzner.json`)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly
- `HETZNER_SERVER_TYPE` - Server type (default: `cx22`)
- `HETZNER_LOCATION` - Datacenter location (default: `fsn1`)

---

## DigitalOcean

Spawn agents on [DigitalOcean](https://www.digitalocean.com/) Droplets via REST API.

### Usage

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/nanoclaw.sh)
```

### Non-Interactive Mode

```bash
DO_DROPLET_NAME=dev-mk1 \
DO_API_TOKEN=your-digitalocean-api-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/claude.sh)
```

**Environment Variables:**
- `DO_DROPLET_NAME` - Name for the droplet (skips prompt)
- `DO_API_TOKEN` - DigitalOcean API token (skips prompt, saved to `~/.config/spawn/digitalocean.json`)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly
- `DO_DROPLET_SIZE` - Droplet size (default: `s-2vcpu-2gb`)
- `DO_REGION` - Datacenter region (default: `nyc3`)
