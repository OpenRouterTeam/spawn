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

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/interpreter.sh)
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

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/hetzner/interpreter.sh)
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

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/digitalocean/interpreter.sh)
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

---

## Vultr

Spawn agents on [Vultr](https://www.vultr.com/) Cloud Compute instances via REST API.

### Usage

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/interpreter.sh)
```

### Non-Interactive Mode

```bash
VULTR_SERVER_NAME=dev-mk1 \
VULTR_API_KEY=your-vultr-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/vultr/claude.sh)
```

**Environment Variables:**
- `VULTR_SERVER_NAME` - Name for the instance (skips prompt)
- `VULTR_API_KEY` - Vultr API key (skips prompt, saved to `~/.config/spawn/vultr.json`)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly
- `VULTR_PLAN` - Instance plan (default: `vc2-1c-2gb`)
- `VULTR_REGION` - Datacenter region (default: `ewr`)

---

## Linode (Akamai)

Spawn agents on [Linode](https://www.linode.com/) instances via REST API.

### Usage

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/interpreter.sh)
```

### Non-Interactive Mode

```bash
LINODE_SERVER_NAME=dev-mk1 \
LINODE_API_TOKEN=your-linode-api-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/linode/claude.sh)
```

**Environment Variables:**
- `LINODE_SERVER_NAME` - Label for the Linode (skips prompt)
- `LINODE_API_TOKEN` - Linode API token (skips prompt, saved to `~/.config/spawn/linode.json`)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly
- `LINODE_TYPE` - Instance type (default: `g6-standard-1`)
- `LINODE_REGION` - Datacenter region (default: `us-east`)

---

## Security

### API Token Storage

Spawn stores cloud provider API tokens and OpenRouter API keys locally in JSON files at `~/.config/spawn/`:

- `hetzner.json` - Hetzner Cloud API token
- `digitalocean.json` - DigitalOcean API token
- `vultr.json` - Vultr API key
- `linode.json` - Linode API token
- OpenRouter API keys stored in shell config files (`~/.bashrc`, `~/.zshrc`)

**Security Posture:**
- All token files are created with `chmod 600` (user read/write only)
- Tokens are stored in **plaintext** - not encrypted at rest
- Security relies on filesystem permissions and OS user isolation

**Recommendations:**
1. **Protect your user account** - Use strong passwords, disk encryption, and secure your SSH keys
2. **Use dedicated API tokens** - Create tokens specifically for Spawn with minimal required permissions
3. **Rotate tokens regularly** - Revoke and regenerate API tokens periodically
4. **Multi-user systems** - On shared machines, be aware that root users can read these files
5. **Backup security** - Ensure backups of `~/.config/` are encrypted

**Why plaintext?**
- Simplicity and compatibility across all Unix-like systems
- File permissions (`600`) provide adequate protection for single-user machines
- Encryption at rest would require key management, adding complexity without significant security benefit for typical use cases
- Cloud providers recommend similar approaches for CLI tools (AWS CLI, gcloud, etc.)

**Alternative approaches:**
- For higher security requirements, consider using environment variables instead of saved tokens
- Pass `OPENROUTER_API_KEY`, `HCLOUD_TOKEN`, etc. as environment variables on each run
- Use OS credential stores (Keychain on macOS, Secret Service on Linux) - requires additional dependencies
