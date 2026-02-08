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

## Agents

| Agent | Description |
|-------|-------------|
| Claude Code | Anthropic's CLI coding agent |
| OpenClaw | OpenRouter's agent framework |
| NanoClaw | WhatsApp-based AI agent |
| Aider | AI pair programming in the terminal |
| Goose | Block's model-agnostic coding agent |
| Codex CLI | OpenAI's open-source coding agent |
| Open Interpreter | Natural language computer control |
| Gemini CLI | Google's coding agent |
| Amazon Q | AWS's AI coding assistant |
| Cline | Open-source terminal coding agent |
| gptme | Personal AI agent with tools |

## Clouds

| Cloud | Type | Auth |
|-------|------|------|
| [Sprite](sprite/) | Managed VM | `sprite login` |
| [Hetzner](hetzner/) | REST API | `HCLOUD_TOKEN` |
| [DigitalOcean](digitalocean/) | REST API | `DO_API_TOKEN` |
| [Vultr](vultr/) | REST API | `VULTR_API_KEY` |
| [Linode](linode/) | REST API | `LINODE_API_TOKEN` |
| [Lambda](lambda/) | REST API | `LAMBDA_API_KEY` |
| [AWS Lightsail](aws-lightsail/) | AWS CLI | `aws configure` |
| [GCP](gcp/) | gcloud CLI | `gcloud auth login` |
| [E2B](e2b/) | SDK | `E2B_API_KEY` |
| [Modal](modal/) | SDK | `modal setup` |
| [Fly.io](fly/) | CLI + API | `FLY_API_TOKEN` |

## Development

```bash
git clone https://github.com/OpenRouterTeam/spawn.git
cd spawn
git config core.hooksPath .githooks
```
