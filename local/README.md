# Local Machine

Run agents directly on your local machine without any cloud provisioning.

> No server creation or destruction. Installs agents and injects OpenRouter credentials locally. Useful for local development and testing.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/nanoclaw.sh)
```

## Non-Interactive Mode

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/local/claude.sh)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (prompted via OAuth if not set) |
| `SPAWN_PROMPT` | If set, runs the agent non-interactively with this prompt |
