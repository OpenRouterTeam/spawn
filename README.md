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

**Environment Variables:**
- `SPRITE_NAME` - Name for the sprite (skips prompt)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key directly
