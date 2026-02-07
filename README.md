# Spawn

Conjure your agents!

## Features

- 🔐 **Automatic OAuth** - Seamless authentication with OpenRouter
- 🔄 **Smart Fallback** - Manual API key entry if OAuth fails
- 🚀 **One Command Setup** - Get running in minutes
- 🔧 **Environment Ready** - Pre-configured shell and dependencies

## Usage

### Interactive Mode

Run the scripts and provide input when prompted:

```bash
# Claude Code
curl https://openrouter.ai/lab/spawn/sprite/claude.sh | bash

# OpenClaw
curl https://openrouter.ai/lab/spawn/sprite/openclaw.sh | bash
```

### Non-Interactive Mode

For automation or CI/CD, set environment variables:

```bash
# Claude Code
SPRITE_NAME=dev-mk1 \
  curl https://openrouter.ai/lab/spawn/sprite/claude.sh | bash

# OpenClaw (with optional API key)
SPRITE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  curl https://openrouter.ai/lab/spawn/sprite/openclaw.sh | bash
```

**Environment Variables:**
- `SPRITE_NAME` - Name for the sprite (required for non-interactive)
- `OPENROUTER_API_KEY` - Skip OAuth and use this API key (optional)
