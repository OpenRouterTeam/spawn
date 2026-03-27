# Spawn

Launch any AI agent on any cloud with a single command. Coding agents, research agents, self-hosted AI tools — Spawn deploys them all. All models powered by [OpenRouter](https://openrouter.ai). (ALPHA software, use at your own risk!)

**8 agents. 5 clouds. 40 working combinations. Zero config.**

## Install

**macOS / Linux — and Windows users inside a WSL2 terminal (Ubuntu, Debian, etc.):**
```bash
curl -fsSL https://openrouter.ai/labs/spawn/cli/install.sh | bash
```

**Windows PowerShell (outside WSL):**
```powershell
irm https://openrouter.ai/labs/spawn/cli/install.ps1 | iex
```

## Usage

```bash
spawn                         # Interactive picker
spawn <agent> <cloud>         # Launch directly
spawn matrix                  # Show the full agent x cloud matrix
```

### Examples

```bash
spawn                                    # Interactive picker
spawn claude sprite                      # Claude Code on Sprite
spawn codex hetzner                      # Codex CLI on Hetzner
spawn claude sprite --prompt "Fix bugs"  # Non-interactive with prompt
spawn codex sprite -p "Add tests"        # Short form
spawn claude                             # Show clouds available for Claude
spawn delete                             # Delete a running server
spawn delete -c hetzner                  # Delete a server on Hetzner
```

### Commands

| Command | Description |
|---------|-------------|
| `spawn` | Interactive agent + cloud picker |
| `spawn <agent> <cloud>` | Launch agent on cloud directly |
| `spawn <agent> <cloud> --dry-run` | Preview without provisioning |
| `spawn <agent> <cloud> --zone <zone>` | Set zone/region for the cloud |
| `spawn <agent> <cloud> --size <type>` | Set instance size/type for the cloud |
| `spawn <agent> <cloud> -p "text"` | Non-interactive with prompt |
| `spawn <agent> <cloud> --prompt-file f.txt` | Prompt from file |
| `spawn <agent> <cloud> --headless` | Provision and exit (no interactive session) |
| `spawn <agent> <cloud> --output json` | Headless mode with structured JSON on stdout |
| `spawn <agent> <cloud> --model <id>` | Set the model ID (overrides agent default) |
| `spawn <agent> <cloud> --config <file>` | Load options from a JSON config file |
| `spawn <agent> <cloud> --steps <list>` | Comma-separated setup steps to enable |
| `spawn <agent> <cloud> --custom` | Show interactive size/region pickers |
| `spawn <agent>` | Show available clouds for an agent |
| `spawn <cloud>` | Show available agents for a cloud |
| `spawn matrix` | Full agent x cloud matrix |
| `spawn list` | Browse and rerun previous spawns |
| `spawn list <filter>` | Filter history by agent or cloud name |
| `spawn list -a <agent>` | Filter history by agent |
| `spawn list -c <cloud>` | Filter history by cloud |
| `spawn list --flat` | Show flat list (disable tree view) |
| `spawn list --json` | Output history as JSON |
| `spawn list --clear` | Clear all spawn history |
| `spawn tree` | Show recursive spawn tree (parent/child relationships) |
| `spawn tree --json` | Output spawn tree as JSON |
| `spawn history export` | Dump history as JSON to stdout (used by parent VMs) |
| `spawn fix` | Re-run agent setup on an existing VM (re-inject credentials, reinstall) |
| `spawn fix <spawn-id>` | Fix a specific spawn by name or ID |
| `spawn link <ip>` | Register an existing VM by IP |
| `spawn link <ip> --agent <agent>` | Specify the agent running on the VM |
| `spawn link <ip> --cloud <cloud>` | Specify the cloud provider |
| `spawn last` | Instantly rerun the most recent spawn |
| `spawn agents` | List all agents with descriptions |
| `spawn clouds` | List all cloud providers |
| `spawn feedback "message"` | Send feedback to the Spawn team |
| `spawn uninstall` | Uninstall spawn CLI and optionally remove data |
| `spawn update` | Check for CLI updates |
| `spawn delete` | Interactively select and destroy a cloud server |
| `spawn delete -a <agent>` | Filter servers to delete by agent |
| `spawn delete -c <cloud>` | Filter servers to delete by cloud |
| `spawn delete --name <name> --yes` | Headless delete by name (no prompts) |
| `spawn status` | Show live state of cloud servers |
| `spawn status -a <agent>` | Filter status by agent |
| `spawn status -c <cloud>` | Filter status by cloud |
| `spawn status --prune` | Remove gone servers from history |
| `spawn help` | Show help message |
| `spawn version` | Show version |

#### Config File

The `--config` flag loads options from a JSON file. CLI flags override config values.

```json
{
  "model": "openai/gpt-5.3-codex",
  "steps": ["github", "browser", "telegram"],
  "name": "my-dev-box",
  "setup": {
    "telegram_bot_token": "123456:ABC-DEF...",
    "github_token": "ghp_xxxx"
  }
}
```

```bash
spawn codex gcp --config setup.json --headless --output json
```

#### Setup Steps

Control which optional setup steps run with `--steps`:

```bash
spawn openclaw gcp --steps github,browser     # Only GitHub + Chrome
spawn claude gcp --steps ""                    # Skip all optional steps
```

Available steps vary by agent:

| Step | Agents | Description |
|------|--------|-------------|
| `github` | All | GitHub CLI + git identity |
| `reuse-api-key` | All | Reuse saved OpenRouter key |
| `browser` | openclaw | Chrome browser (~400 MB) |
| `telegram` | openclaw | Telegram bot (set `TELEGRAM_BOT_TOKEN` for non-interactive) |
| `whatsapp` | openclaw | WhatsApp linking (interactive QR scan, skipped in headless) |

#### Fast Mode

Use `--fast` for significantly faster deploys. Enables all speed optimizations:

```bash
spawn claude hetzner --fast
```

What `--fast` does:
- **Parallel boot**: server creation runs concurrently with API key prompt and account checks
- **Tarballs**: installs agents from pre-built tarballs instead of live install
- **Skip cloud-init**: for lightweight agents (Claude, OpenCode, ZeroClaw, Hermes), skips the package install wait since the base OS already has what's needed
- **Snapshots**: uses pre-built cloud images when available (Hetzner, DigitalOcean)

#### Beta Features

Individual optimizations can be enabled separately with `--beta <feature>`. The flag is repeatable:

```bash
spawn claude gcp --beta tarball --beta parallel
```

| Feature | Description |
|---------|-------------|
| `tarball` | Use pre-built tarball for agent install (faster, skips live install) |
| `images` | Use pre-built cloud images/snapshots (faster boot) |
| `parallel` | Parallelize server boot with setup prompts |
| `recursive` | Install spawn CLI on VM so it can spawn child VMs |

`--fast` enables `tarball`, `images`, and `parallel` (not `recursive`).

#### Recursive Spawn

Use `--beta recursive` to let spawned VMs create their own child VMs:

```bash
spawn claude hetzner --beta recursive
```

What this does:
- **Installs spawn CLI** on the remote VM
- **Delegates credentials** (cloud + OpenRouter) so child VMs can authenticate
- **Injects parent tracking** (`SPAWN_PARENT_ID`, `SPAWN_DEPTH`) into the VM environment
- **Passes `--beta recursive`** to children so they can also spawn recursively

View the spawn tree:
```bash
spawn tree
# spawn-abc  Claude Code / Hetzner  2m ago
#   ├─ spawn-def  Codex CLI / Hetzner  1m ago
#   └─ spawn-ghi  OpenClaw / Hetzner  30s ago
#       └─ spawn-jkl  Claude Code / Hetzner  10s ago
```

Tear down an entire tree:
```bash
spawn delete --cascade <id>    # Delete a VM and all its children
```

### Without the CLI

Every combination works as a one-liner — no install required:

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/{cloud}/{agent}.sh)
```

### Non-Interactive Mode

Skip prompts by providing environment variables:

```bash
# OpenRouter API key (required for all agents)
export OPENROUTER_API_KEY=sk-or-v1-xxxxx

# Cloud-specific credentials (varies by provider)
# Note: Sprite uses `sprite login` for authentication
export HCLOUD_TOKEN=...           # For Hetzner
export DO_API_TOKEN=...           # For DigitalOcean

# Run non-interactively
spawn claude hetzner
```

You can also use inline environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx spawn claude sprite
```

Get your OpenRouter API key at: https://openrouter.ai/settings/keys

For cloud-specific auth, see each cloud's README in this repository.

## Troubleshooting

### Installation issues

If spawn fails to install, try these steps:

1. **Check bun version**: spawn requires bun >= 1.2.0
   ```bash
   bun --version
   bun upgrade  # if needed
   ```

2. **Manual installation**: If auto-install fails, install bun first
   ```bash
   curl -fsSL https://bun.sh/install | bash
   source ~/.bashrc  # or ~/.zshrc for zsh
   curl -fsSL https://openrouter.ai/labs/spawn/cli/install.sh | bash
   ```

3. **PATH issues**: If `spawn` command not found after install
   ```bash
   # Add to your shell config (~/.bashrc or ~/.zshrc)
   export PATH="$HOME/.local/bin:$PATH"
   ```

### Windows (PowerShell)

1. **Use the PowerShell installer** — not the bash one:
   ```powershell
   irm https://openrouter.ai/labs/spawn/cli/install.ps1 | iex
   ```
   The `.ps1` extension is required. The default `install.sh` is bash and won't work in PowerShell.

2. **Set credentials via environment variables** before launching:
   ```powershell
   $env:OPENROUTER_API_KEY = "sk-or-v1-xxxxx"
   $env:DO_API_TOKEN = "dop_v1_xxxxx"      # For DigitalOcean
   $env:HCLOUD_TOKEN = "xxxxx"              # For Hetzner
   spawn openclaw digitalocean
   ```

3. **Local build failures during auto-update** are normal on Windows — the CLI falls back to a pre-built binary automatically. You may see a brief build error followed by a successful update.

4. **EISDIR or EEXIST errors on config files**: If you see errors about `digitalocean.json` being a directory, delete it:
   ```powershell
   Remove-Item -Recurse -Force "$HOME\.config\spawn\digitalocean.json" -ErrorAction SilentlyContinue
   spawn openclaw digitalocean
   ```

### Headless JSON mode — agent exits immediately

When using `--headless --output json` with Claude Code, you must also pass `--prompt` (or `-p`). Without it, Claude exits with `Input must be provided through stdin or --prompt` and the JSON output will show `"status":"error"`:

```bash
# WRONG — Claude exits immediately
spawn claude gcp --headless --output json

# RIGHT — provide a prompt
spawn claude gcp --headless --output json --prompt "Fix all linter errors"
```

Note: auto-update messages may appear before the JSON on older CLI versions. Run `spawn update` to get the fix.

### Agent launch failures

If an agent fails to install or launch on a cloud:

1. **Check credentials**: Ensure cloud provider credentials are set
   ```bash
   # Example for Hetzner
   export HCLOUD_TOKEN=your-token-here
   spawn claude hetzner
   ```

2. **Try a different cloud**: Some clouds may have temporary issues
   ```bash
   spawn <agent>  # Interactive picker to choose another cloud
   ```

3. **Use --dry-run**: Preview what spawn will do before provisioning
   ```bash
   spawn claude hetzner --dry-run
   ```

4. **Check cloud status**: Visit your cloud provider's status page
   - Many failures are transient (network timeouts, package mirror issues)
   - Retrying often succeeds

### Getting help

- **View command history**: `spawn list` shows all previous launches
- **Rerun last session**: `spawn last` or `spawn rerun`
- **Check version**: `spawn version` shows CLI version and cache status
- **Update spawn**: `spawn update` checks for the latest version
- **Report bugs**: Open an issue at https://github.com/OpenRouterTeam/spawn/issues

## Matrix

| | [Local Machine](sh/local/) | [Hetzner Cloud](sh/hetzner/) | [AWS Lightsail](sh/aws/) | [DigitalOcean](sh/digitalocean/) | [GCP Compute Engine](sh/gcp/) | [Sprite](sh/sprite/) |
|---|---|---|---|---|---|---|
| [**Claude Code**](https://claude.ai) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenClaw**](https://github.com/openclaw/openclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**ZeroClaw**](https://github.com/zeroclaw-labs/zeroclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Codex CLI**](https://github.com/openai/codex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenCode**](https://github.com/sst/opencode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Kilo Code**](https://github.com/Kilo-Org/kilocode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Hermes Agent**](https://github.com/NousResearch/hermes-agent) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Junie**](https://www.jetbrains.com/junie/) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### How it works

Each cell in the matrix is a self-contained bash script that:

1. Provisions a server on the cloud provider
2. Installs the agent
3. Injects your [OpenRouter](https://openrouter.ai) API key so every agent uses the same billing
4. Drops you into an interactive session

Scripts work standalone (`bash <(curl ...)`) or through the CLI.

## Development

```bash
git clone https://github.com/OpenRouterTeam/spawn.git
cd spawn
git config core.hooksPath .githooks
```

### Structure

```
sh/{cloud}/{agent}.sh     # Agent deployment script (thin bash → bun wrapper)
packages/cli/             # TypeScript CLI — all provisioning logic (bun)
manifest.json             # Source of truth for the matrix
```

### Adding a new cloud

1. Add cloud-specific TypeScript module in `packages/cli/src/{cloud}/`
2. Add to `manifest.json`
3. Implement agent scripts
4. See [CLAUDE.md](CLAUDE.md) for full contributor guide

### Adding a new agent

1. Add to `manifest.json`
2. Implement on 1+ cloud by adapting an existing agent script
3. Must support OpenRouter via env var injection

## Contributing

The easiest way to contribute is by testing and reporting issues. You don't need to write code.

### Test a cloud provider

Pick any agent + cloud combination from the matrix and try it out:

```bash
spawn claude hetzner      # or any combination
```

If something breaks, hangs, or behaves unexpectedly, open an issue using the [bug report template](https://github.com/OpenRouterTeam/spawn/issues/new?template=bug_report.yml). Include:

- The exact command you ran
- The cloud provider and agent
- What happened vs. what you expected
- Any error output

### Request a cloud or agent

Want to see a specific cloud provider or agent supported? Use the dedicated templates:

- [Request a cloud provider](https://github.com/OpenRouterTeam/spawn/issues/new?template=cloud_request.yml)
- [Request an agent](https://github.com/OpenRouterTeam/spawn/issues/new?template=agent_request.yml)
- [Request a CLI feature](https://github.com/OpenRouterTeam/spawn/issues/new?template=cli_feature_request.yml)

Requests with real-world use cases get prioritized.

### Report auth or credential issues

Cloud provider APIs change frequently. If you hit authentication failures, expired tokens, or permission errors on a provider that previously worked, please report it — these are high-priority fixes.

### Code contributions

See [CLAUDE.md](CLAUDE.md) for the full contributor guide covering shell script rules, testing, and the shared library pattern.

## License

[Apache 2.0](LICENSE)
