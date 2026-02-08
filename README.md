# Spawn

Launch any agent on any cloud, powered by [OpenRouter](https://openrouter.ai).

## Install

```bash
curl -fsSL https://openrouter.ai/lab/spawn/cli/install.sh | bash
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
spawn aider hetzner                      # Aider on Hetzner Cloud
spawn claude sprite --prompt "Fix bugs"  # Execute with prompt (non-interactive)
spawn aider sprite -p "Add tests"        # Short form of --prompt
spawn claude                             # Show clouds available for Claude
```

### Commands

| Command | Description |
|---------|-------------|
| `spawn` | Interactive agent + cloud picker |
| `spawn <agent> <cloud>` | Launch agent on cloud directly |
| `spawn <agent> <cloud> --prompt "text"` | Execute agent with prompt (non-interactive) |
| `spawn <agent> <cloud> --prompt-file file.txt` | Execute agent with prompt from file |
| `spawn <agent>` | Show available clouds for an agent |
| `spawn list` | Full agent x cloud matrix |
| `spawn agents` | List all agents |
| `spawn clouds` | List all cloud providers |
| `spawn improve` | Run improvement system |
| `spawn update` | Check for CLI updates |
| `spawn version` | Show version |

### Without the CLI

Every combination also works as a one-liner:

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/{cloud}/{agent}.sh)
```

### Non-Interactive

Skip all prompts with environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  spawn claude sprite
```

Each cloud has its own env vars for auth — see the cloud's [README](sprite/README.md).

## Matrix

| | [Sprite](sprite/) | [Hetzner](hetzner/) | [DigitalOcean](digitalocean/) | [Vultr](vultr/) | [Linode](linode/) | [Lambda](lambda/) | [Lightsail](aws-lightsail/) | [GCP](gcp/) | [E2B](e2b/) | [Modal](modal/) | [Fly.io](fly/) | [Civo](civo/) | [Scaleway](scaleway/) | [Daytona](daytona/) | [RunPod](runpod/) | [UpCloud](upcloud/) | [BinaryLane](binarylane/) | [Genesis Cloud](genesiscloud/) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [**Claude Code**](https://claude.ai) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenClaw**](https://github.com/OpenRouterTeam/openclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**NanoClaw**](https://github.com/gavrielc/nanoclaw) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Aider**](https://github.com/paul-gauthier/aider) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Goose**](https://github.com/block/goose) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Codex CLI**](https://github.com/openai/codex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Open Interpreter**](https://github.com/OpenInterpreter/open-interpreter) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Gemini CLI**](https://github.com/google-gemini/gemini-cli) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Amazon Q CLI**](https://aws.amazon.com/q/developer/) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Cline**](https://github.com/cline/cline) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**gptme**](https://github.com/gptme/gptme) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**OpenCode**](https://github.com/opencode-ai/opencode) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| [**Plandex**](https://github.com/plandex-ai/plandex) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## Development

```bash
git clone https://github.com/OpenRouterTeam/spawn.git
cd spawn
git config core.hooksPath .githooks
```
