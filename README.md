# Spawn

Launch any AI agent on any cloud with a single command. Coding agents, research agents, self-hosted AI tools — Spawn deploys them all. All models powered by [OpenRouter](https://openrouter.ai). (ALPHA software, use at your own risk!)

**15 agents. 32 clouds. 455 combinations. Zero config.**

## Install

```bash
curl -fsSL https://openrouter.ai/lab/spawn/cli/install.sh | bash
```

Or install directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
```

## Usage

```bash
spawn                         # Interactive picker
spawn <agent> <cloud>         # Launch directly
spawn list                    # Show the full matrix
```

### Examples

```bash
spawn                                    # Interactive picker
spawn claude sprite                      # Claude Code on Sprite
spawn aider hetzner                      # Aider on Hetzner
spawn claude sprite --prompt "Fix bugs"  # Non-interactive with prompt
spawn aider sprite -p "Add tests"        # Short form
spawn claude                             # Show clouds available for Claude
```

### Commands

| Command | Description |
|---------|-------------|
| `spawn` | Interactive agent + cloud picker |
| `spawn <agent> <cloud>` | Launch agent on cloud directly |
| `spawn <agent> <cloud> --dry-run` | Preview without provisioning |
| `spawn <agent> <cloud> -p "text"` | Non-interactive with prompt |
| `spawn <agent> <cloud> --prompt-file f.txt` | Prompt from file |
| `spawn <agent>` | Show available clouds for an agent |
| `spawn list` | Full agent x cloud matrix |
| `spawn agents` | List all agents |
| `spawn clouds` | List all cloud providers |
| `spawn update` | Check for CLI updates |

### Without the CLI

Every combination works as a one-liner — no install required:

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/{cloud}/{agent}.sh)
```

### Non-Interactive Mode

Skip prompts by providing environment variables:

```bash
# OpenRouter API key (required for all agents)
export OPENROUTER_API_KEY=sk-or-v1-xxxxx

# Cloud-specific credentials (varies by provider)
export SPRITE_API_KEY=...        # For Sprite
export HCLOUD_TOKEN=...           # For Hetzner
export DO_API_TOKEN=...           # For DigitalOcean

# Run non-interactively
spawn claude sprite
```

You can also use inline environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx spawn claude sprite
```

Get your OpenRouter API key at: https://openrouter.ai/settings/keys

For cloud-specific auth, see each cloud's README in this repository.

## Matrix

| | [Sprite](sprite/) | [Hetzner Cloud](hetzner/) | [DigitalOcean](digitalocean/) | [Vultr](vultr/) | [Linode (Akamai)](linode/) | [AWS Lightsail](aws-lightsail/) | [GCP Compute Engine](gcp/) | [GitHub Codespaces](github-codespaces/) | [E2B](e2b/) | [Modal](modal/) | [Fly.io](fly/) | [Civo](civo/) | [Scaleway](scaleway/) | [Daytona](daytona/) | [UpCloud](upcloud/) | [BinaryLane](binarylane/) | [Latitude.sh](latitude/) | [OVHcloud](ovh/) | [Kamatera](kamatera/) | [Cherry Servers](cherry/) | [Oracle Cloud Infrastructure](oracle/) | [Koyeb](koyeb/) | [Northflank](northflank/) | [Railway](railway/) | [Render](render/) | [IONOS Cloud](ionos/) | [Exoscale](exoscale/) | [Contabo](contabo/) | [Hostinger](hostinger/) | [Netcup](netcup/) | [Local Machine](local/) | [RamNode](ramnode/) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [**Claude Code**](https://claude.ai) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenClaw**](https://github.com/OpenRouterTeam/openclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |
| [**NanoClaw**](https://github.com/gavrielc/nanoclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |
| [**Aider**](https://github.com/paul-gauthier/aider) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   | ✓ |
| [**Goose**](https://github.com/block/goose) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Codex CLI**](https://github.com/openai/codex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |
| [**Open Interpreter**](https://github.com/OpenInterpreter/open-interpreter) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   | ✓ |
| [**Gemini CLI**](https://github.com/google-gemini/gemini-cli) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |
| [**Amazon Q CLI**](https://aws.amazon.com/q/developer/) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |
| [**Cline**](https://github.com/cline/cline) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |
| [**gptme**](https://github.com/gptme/gptme) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
| [**OpenCode**](https://github.com/opencode-ai/opencode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
| [**Plandex**](https://github.com/plandex-ai/plandex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
| [**Kilo Code**](https://github.com/Kilo-Org/kilocode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |   |
| [**Continue**](https://github.com/continuedev/continue) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |   |   |
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

## License

[Apache 2.0](LICENSE)
