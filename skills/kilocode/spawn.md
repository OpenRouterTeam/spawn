# Spawn — Create Child VMs

You have the `spawn` CLI installed. Use it to provision cloud VMs with AI agents.

## Usage

```bash
spawn <agent> <cloud> --headless --output json --prompt "task description"
```

## Agents: claude, codex, openclaw, zeroclaw, opencode, kilocode, hermes, junie
## Clouds: hetzner, digitalocean, aws, gcp, sprite

## Example

```bash
spawn claude hetzner --headless --output json --prompt "Implement the auth module"
```

Returns JSON: `{"status":"success","ip_address":"...","ssh_user":"root","server_id":"..."}`

## Managing Children

- `spawn list --json` — see running children
- `spawn delete --name <name> --yes` — tear down a child VM
- `spawn tree` — see the full spawn tree

## Context

- You are running inside a spawned VM (SPAWN_DEPTH is set)
- Cloud credentials are pre-configured — no auth prompts
- OpenRouter billing is shared with the parent
