# Daytona

Daytona sandboxed environments for AI code execution. [Daytona](https://www.daytona.io/)

> Sub-90ms sandbox creation. True SSH support via `daytona ssh`. Requires `DAYTONA_API_KEY` from https://app.daytona.io.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/kilocode.sh)
```

## Non-Interactive Mode

```bash
DAYTONA_SANDBOX_NAME=dev-mk1 \
DAYTONA_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/daytona/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DAYTONA_API_KEY` | Daytona API key | _(prompted)_ |
| `DAYTONA_SANDBOX_NAME` | Sandbox name | _(prompted)_ |
| `DAYTONA_CLASS` | Sandbox class (e.g. `small`, `medium`, `large`) | `small` |
| `DAYTONA_CPU` | Number of vCPUs (overrides `--class`) | _(unset)_ |
| `DAYTONA_MEMORY` | Memory in MB (overrides `--class`) | _(unset)_ |
| `DAYTONA_DISK` | Disk size in GB (overrides `--class`) | _(unset)_ |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

> **Note:** Daytona rejects explicit `--cpu`/`--memory`/`--disk` flags when using snapshots.
> Use `DAYTONA_CLASS` instead. If explicit resource flags fail due to snapshot conflict, spawn automatically retries with `--class small`.
