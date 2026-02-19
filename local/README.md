# Local Machine

Run agents directly on your local machine without any cloud provisioning.

> No server creation or destruction. Installs agents and injects OpenRouter credentials locally. Useful for local development and testing.

## Quick Start

If you have the [spawn CLI](https://github.com/OpenRouterTeam/spawn) installed:

```bash
spawn claude local
spawn openclaw local
spawn nanoclaw local
spawn codex local
spawn cline local
spawn gptme local
spawn opencode local
spawn plandex local
spawn kilocode local
spawn continue local
```

Or run directly without the CLI:

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/claude.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/openclaw.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/nanoclaw.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/codex.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/cline.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/gptme.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/opencode.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/plandex.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/kilocode.sh)
bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/continue.sh)
```

## Non-Interactive Mode

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/local/claude.sh)
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
