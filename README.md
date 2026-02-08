# Spawn

Launch any AI coding agent on any cloud, pre-configured with [OpenRouter](https://openrouter.ai).

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
spawn claude sprite           # Claude Code on Sprite
spawn aider hetzner           # Aider on Hetzner Cloud
spawn goose digitalocean      # Goose on DigitalOcean
spawn codex vultr             # Codex CLI on Vultr
```

### Commands

| Command | Description |
|---------|-------------|
| `spawn` | Interactive agent + cloud picker |
| `spawn <agent> <cloud>` | Launch agent on cloud directly |
| `spawn <agent>` | Show available clouds for an agent |
| `spawn list` | Full agent x cloud matrix |
| `spawn agents` | List all agents |
| `spawn clouds` | List all cloud providers |

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

| | [Sprite](sprite/) | [Hetzner](hetzner/) | [DigitalOcean](digitalocean/) | [Vultr](vultr/) | [Linode](linode/) | [Lambda](lambda/) | [Lightsail](aws-lightsail/) | [GCP](gcp/) | [E2B](e2b/) | [Modal](modal/) | [Fly.io](fly/) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **OpenClaw** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **NanoClaw** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Aider** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Goose** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Codex CLI** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Interpreter** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Gemini CLI** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Amazon Q** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Cline** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **gptme** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## Development

```bash
git clone https://github.com/OpenRouterTeam/spawn.git
cd spawn
git config core.hooksPath .githooks
```
