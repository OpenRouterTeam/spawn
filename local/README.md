# Local Machine

Run agents directly on your local machine without any cloud provisioning.

> No server creation or destruction. Installs agents and injects OpenRouter credentials locally. Useful for local development and testing.

## Quick Start

If you have the [spawn CLI](https://github.com/OpenRouterTeam/spawn) installed:

```bash
spawn claude local
spawn openclaw local
spawn nanoclaw local
spawn aider local
spawn goose local
spawn cline local
```

Or run directly without the CLI:

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/claude.sh)
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/openclaw.sh)
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/nanoclaw.sh)
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/aider.sh)
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/goose.sh)
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/cline.sh)
```

## Non-Interactive Mode

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/claude.sh)
```

## What It Does

Local scripts will:
- Install the agent if not already present
- Obtain an OpenRouter API key (via OAuth or environment variable)
- Append environment variables to `~/.zshrc` for the agent to use
- Launch the agent

No cloud servers are created or destroyed.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (prompted via OAuth if not set) |
| `SPAWN_PROMPT` | If set, runs the agent non-interactively with this prompt |
