# Spawn

Conjure your agents!

## Features

- 🔐 **Automatic OAuth** - Seamless authentication with OpenRouter
- 🔄 **Smart Fallback** - Manual API key entry if OAuth fails
- 🚀 **One Command Setup** - Get running in minutes
- 🔧 **Environment Ready** - Pre-configured shell and dependencies

## Usage

### Interactive Mode (Recommended)

Use process substitution for full interactivity:

```bash
# Claude Code - Prompts for sprite name and OAuth
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/claude.sh)

# OpenClaw - Prompts for sprite name, OAuth, and model selection
bash <(curl -fsSL https://openrouter.ai/lab/spawn/sprite/openclaw.sh)
```

**Why `bash <(curl ...)` instead of `curl | bash`?**
- Process substitution keeps stdin available for interactive prompts
- No special TTY handling required
- Works like a normal bash script

### Alternative: Piping (Requires env vars)

If using the shorter `curl | bash` pattern (like the OpenRouter documentation shows), you must set environment variables:

```bash
# Claude Code - As shown on openrouter.ai/lab/spawn
SPRITE_NAME=dev-mk1 curl https://openrouter.ai/lab/spawn/sprite/claude.sh | bash

# OpenClaw
SPRITE_NAME=dev-mk1 curl https://openrouter.ai/lab/spawn/sprite/openclaw.sh | bash
```

**Note:** The OpenRouter URLs (`openrouter.ai/lab/spawn/...`) may redirect or proxy to this repository.

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
