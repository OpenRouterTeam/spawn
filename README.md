# Spawn

Launch any AI agent on any cloud with a single command. Coding agents, research agents, self-hosted AI tools — Spawn deploys them all. All models powered by [OpenRouter](https://openrouter.ai). (ALPHA software, use at your own risk!)

**6 agents. 8 clouds. 48 working combinations. Zero config.**

## Install

```bash
curl -fsSL https://openrouter.ai/labs/spawn/cli/install.sh | bash
```

Or install directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
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
| `spawn <agent> <cloud> -p "text"` | Non-interactive with prompt |
| `spawn <agent> <cloud> --prompt-file f.txt` | Prompt from file |
| `spawn <agent> <cloud> --debug` | Show all commands being executed |
| `spawn <agent>` | Show available clouds for an agent |
| `spawn <cloud>` | Show available agents for a cloud |
| `spawn matrix` | Full agent x cloud matrix |
| `spawn list` | Browse and rerun previous spawns |
| `spawn list <filter>` | Filter history by agent or cloud name |
| `spawn list -a <agent>` | Filter history by agent |
| `spawn list -c <cloud>` | Filter history by cloud |
| `spawn list --clear` | Clear all spawn history |
| `spawn last` | Instantly rerun the most recent spawn |
| `spawn agents` | List all agents with descriptions |
| `spawn clouds` | List all cloud providers |
| `spawn update` | Check for CLI updates |
| `spawn delete` | Interactively select and destroy a cloud server |
| `spawn delete -a <agent>` | Filter servers to delete by agent |
| `spawn delete -c <cloud>` | Filter servers to delete by cloud |
| `spawn help` | Show help message |
| `spawn version` | Show version |

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
   curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
   ```

3. **PATH issues**: If `spawn` command not found after install
   ```bash
   # Add to your shell config (~/.bashrc or ~/.zshrc)
   export PATH="$HOME/.local/bin:$PATH"
   ```

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

| | [Local Machine](local/) | [Hetzner Cloud](hetzner/) | [Fly.io](fly/) | [AWS Lightsail](aws/) | [Daytona](daytona/) | [DigitalOcean](digitalocean/) | [GCP Compute Engine](gcp/) | [Sprite](sprite/) |
|---|---|---|---|---|---|---|---|---|
| [**Claude Code**](https://claude.ai) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenClaw**](https://github.com/openclaw/openclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**ZeroClaw**](https://github.com/zeroclaw-labs/zeroclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Codex CLI**](https://github.com/openai/codex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenCode**](https://github.com/anomalyco/opencode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Kilo Code**](https://github.com/Kilo-Org/kilocode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

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
{cloud}/lib/common.sh    # Cloud provider primitives (provision, SSH, cleanup)
{cloud}/{agent}.sh        # Agent deployment script
shared/common.sh          # Shared utilities (OAuth, logging, SSH helpers)
cli/                      # TypeScript CLI (bun)
manifest.json             # Source of truth for the matrix
```

### Adding a new cloud

1. Create `{cloud}/lib/common.sh` with provisioning primitives
2. Add to `manifest.json`
3. Implement agent scripts using the cloud's primitives
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
