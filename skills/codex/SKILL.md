---
name: spawn
description: Create child cloud VMs with AI coding agents using the spawn CLI
allowed-tools: Bash
---

# Spawn — Create Child VMs

You have the `spawn` CLI installed. Use it to provision cloud VMs with AI agents.

## Provision a Child VM

```bash
spawn <agent> <cloud> --headless --output json --prompt "task description"
```

**Agents:** claude, codex, cursor, openclaw, zeroclaw, opencode, kilocode, hermes, junie
**Clouds:** hetzner, digitalocean, aws, gcp, sprite

Returns JSON: `{"status":"success","ip_address":"...","ssh_user":"root","server_id":"..."}`

## Running Prompts on Child VMs

`--headless` only provisions — to run work on the child, SSH in with `bash -lc`:

```bash
# Claude Code (use -p, NOT --print or --headless)
ssh -o StrictHostKeyChecking=accept-new root@<ip> "bash -lc 'claude -p --dangerously-skip-permissions \"your prompt\"'"

# Codex CLI
ssh -o StrictHostKeyChecking=accept-new root@<ip> "bash -lc 'codex --quiet \"your prompt\"'"
```

### IMPORTANT — do NOT waste tokens rediscovering these:
- **Always use `bash -lc`** — agent binaries are in `~/.local/bin/` which is only on PATH in login shells
- **Claude uses `-p`** for non-interactive output (NOT `--print`, NOT `--headless`)
- **Add `--dangerously-skip-permissions`** to skip approval prompts on child VMs
- **Never try `which claude` or `find`** to locate binaries — they are always at `~/.local/bin/<agent>`
- **Never create non-root users** to work around permission issues — just use `-p`

## Managing Children

- `spawn list --json` — see running children
- `spawn delete --name <name> --yes` — tear down a child VM (headless)
- `spawn tree` — see the full spawn tree

## Context

- You are running inside a spawned VM (SPAWN_DEPTH is set)
- Cloud credentials are pre-configured — no auth prompts
- OpenRouter billing is shared with the parent
