# Agent Default Models

**Source of truth for the default LLM each agent uses via OpenRouter.**
When updating an agent's default model, update BOTH the code and this file. This prevents regressions from stale model IDs.

Last verified: 2026-03-12

| Agent | Default Model | How It's Set |
|---|---|---|
| Claude Code | _(routed by Anthropic)_ | `ANTHROPIC_BASE_URL=https://openrouter.ai/api` — model selection handled by Claude's own routing |
| Codex CLI | `openai/gpt-5.3-codex` | Hardcoded in `setupCodexConfig()` → `~/.codex/config.toml` |
| OpenClaw | `openrouter/openrouter/auto` | `modelDefault` field in agent config; written to OpenClaw config via `setupOpenclawConfig()` |
| ZeroClaw | _(provider default)_ | `ZEROCLAW_PROVIDER=openrouter` — model selection handled by ZeroClaw's OpenRouter integration |
| OpenCode | _(provider default)_ | `OPENROUTER_API_KEY` env var — model selection handled by OpenCode natively |
| Kilo Code | _(provider default)_ | `KILO_PROVIDER_TYPE=openrouter` — model selection handled by Kilo Code natively |
| Hermes | _(provider default)_ | `OPENAI_BASE_URL=https://openrouter.ai/api/v1` + `OPENAI_API_KEY` — model selection handled by Hermes |
| Junie | _(provider default)_ | `JUNIE_OPENROUTER_API_KEY` — model selection handled by Junie natively |

## When to update

- When OpenRouter adds a newer version of a model (e.g., `gpt-5.1-codex` → `gpt-5.3-codex`)
- When an agent changes its default provider integration
- Verify the model ID exists on OpenRouter before committing: `curl -s https://openrouter.ai/api/v1/models | jq '.data[].id' | grep <model>`
