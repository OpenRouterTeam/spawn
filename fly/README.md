# Fly.io

Fly.io Machines via REST API and flyctl CLI. [Fly.io](https://fly.io)

## Architecture

The Fly.io provider is implemented in TypeScript (Bun runtime). Each `.sh` agent
script is a thin shim that ensures bun is installed, downloads the TS sources if
running via `bash <(curl ...)`, and delegates to `main.ts`.

```
fly/
  main.ts               # Orchestrator: auth → provision → install → launch
  lib/
    fly.ts              # Core provider: API client, auth, orgs, provisioning
    agents.ts           # Agent configs (all 6) + shared install/config helpers
    oauth.ts            # OpenRouter OAuth flow (Bun.serve), key validation
    ui.ts               # Logging (ANSI), prompts (readline), browser open
  {agent}.sh            # Thin bash shim → bun run main.ts {agent}
```

**No external dependencies** — all modules use built-in Bun/Node APIs only.
The `fly/` directory has no `package.json`.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/kilocode.sh)
```

## Non-Interactive Mode

```bash
FLY_APP_NAME=dev-mk1 \
FLY_API_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/fly/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FLY_API_TOKEN` | Fly.io API token | _(prompted or from flyctl auth)_ |
| `FLY_APP_NAME` | App name | _(prompted)_ |
| `FLY_REGION` | Deployment region | `iad` |
| `FLY_VM_SIZE` | VM size | `shared-cpu-1x` |
| `FLY_VM_MEMORY` | VM memory (MB) | `1024` |
| `FLY_ORG` | Organization slug | `personal` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |
