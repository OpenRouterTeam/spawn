

## Spawn Capability

You have the `spawn` CLI for creating child cloud VMs with AI agents.
Use `spawn <agent> <cloud> --headless --output json --prompt "task"` to delegate work.
Available agents: claude, codex, cursor, openclaw, opencode, kilocode, hermes, junie.
Cloud credentials are pre-configured. Run `spawn list --json` to see children.
`--headless` only provisions. To run a prompt on the child: `ssh root@<ip> "bash -lc 'claude -p --dangerously-skip-permissions \"prompt\"'"`. Always use `bash -lc` (binaries are in ~/.local/bin/).
