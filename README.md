# Spawn

One command to launch any AI coding agent on any cloud, pre-configured with [OpenRouter](https://openrouter.ai).

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/{cloud}/{agent}.sh)
```

## Matrix

| | [Sprite](sprite/) | [Hetzner](hetzner/) | [DigitalOcean](digitalocean/) | [Vultr](vultr/) | [Linode](linode/) | [Lambda](lambda/) | [AWS Lightsail](aws-lightsail/) | [GCP](gcp/) | [E2B](e2b/) | [Modal](modal/) |
|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | [launch](sprite/claude.sh) | [launch](hetzner/claude.sh) | [launch](digitalocean/claude.sh) | [launch](vultr/claude.sh) | [launch](linode/claude.sh) | [launch](lambda/claude.sh) | [launch](aws-lightsail/claude.sh) | [launch](gcp/claude.sh) | [launch](e2b/claude.sh) | [launch](modal/claude.sh) |
| **OpenClaw** | [launch](sprite/openclaw.sh) | [launch](hetzner/openclaw.sh) | [launch](digitalocean/openclaw.sh) | [launch](vultr/openclaw.sh) | [launch](linode/openclaw.sh) | [launch](lambda/openclaw.sh) | [launch](aws-lightsail/openclaw.sh) | [launch](gcp/openclaw.sh) | [launch](e2b/openclaw.sh) | [launch](modal/openclaw.sh) |
| **NanoClaw** | [launch](sprite/nanoclaw.sh) | [launch](hetzner/nanoclaw.sh) | [launch](digitalocean/nanoclaw.sh) | [launch](vultr/nanoclaw.sh) | [launch](linode/nanoclaw.sh) | [launch](lambda/nanoclaw.sh) | [launch](aws-lightsail/nanoclaw.sh) | [launch](gcp/nanoclaw.sh) | [launch](e2b/nanoclaw.sh) | [launch](modal/nanoclaw.sh) |
| **Aider** | [launch](sprite/aider.sh) | [launch](hetzner/aider.sh) | [launch](digitalocean/aider.sh) | [launch](vultr/aider.sh) | [launch](linode/aider.sh) | [launch](lambda/aider.sh) | [launch](aws-lightsail/aider.sh) | [launch](gcp/aider.sh) | [launch](e2b/aider.sh) | [launch](modal/aider.sh) |
| **Goose** | [launch](sprite/goose.sh) | [launch](hetzner/goose.sh) | [launch](digitalocean/goose.sh) | [launch](vultr/goose.sh) | [launch](linode/goose.sh) | [launch](lambda/goose.sh) | [launch](aws-lightsail/goose.sh) | [launch](gcp/goose.sh) | [launch](e2b/goose.sh) | [launch](modal/goose.sh) |
| **Codex CLI** | [launch](sprite/codex.sh) | [launch](hetzner/codex.sh) | [launch](digitalocean/codex.sh) | [launch](vultr/codex.sh) | [launch](linode/codex.sh) | [launch](lambda/codex.sh) | [launch](aws-lightsail/codex.sh) | [launch](gcp/codex.sh) | [launch](e2b/codex.sh) | [launch](modal/codex.sh) |
| **Open Interpreter** | [launch](sprite/interpreter.sh) | [launch](hetzner/interpreter.sh) | [launch](digitalocean/interpreter.sh) | [launch](vultr/interpreter.sh) | [launch](linode/interpreter.sh) | [launch](lambda/interpreter.sh) | [launch](aws-lightsail/interpreter.sh) | [launch](gcp/interpreter.sh) | [launch](e2b/interpreter.sh) | [launch](modal/interpreter.sh) |
| **Gemini CLI** | [launch](sprite/gemini.sh) | [launch](hetzner/gemini.sh) | [launch](digitalocean/gemini.sh) | [launch](vultr/gemini.sh) | [launch](linode/gemini.sh) | [launch](lambda/gemini.sh) | [launch](aws-lightsail/gemini.sh) | [launch](gcp/gemini.sh) | [launch](e2b/gemini.sh) | [launch](modal/gemini.sh) |
| **Amazon Q** | [launch](sprite/amazonq.sh) | [launch](hetzner/amazonq.sh) | [launch](digitalocean/amazonq.sh) | [launch](vultr/amazonq.sh) | [launch](linode/amazonq.sh) | [launch](lambda/amazonq.sh) | [launch](aws-lightsail/amazonq.sh) | [launch](gcp/amazonq.sh) | [launch](e2b/amazonq.sh) | [launch](modal/amazonq.sh) |
| **Cline** | [launch](sprite/cline.sh) | [launch](hetzner/cline.sh) | [launch](digitalocean/cline.sh) | [launch](vultr/cline.sh) | [launch](linode/cline.sh) | [launch](lambda/cline.sh) | [launch](aws-lightsail/cline.sh) | [launch](gcp/cline.sh) | [launch](e2b/cline.sh) | [launch](modal/cline.sh) |

**10 agents x 10 clouds = 100 combinations.** Every script injects OpenRouter credentials automatically.

## How It Works

Each script:
1. Authenticates with the cloud provider
2. Provisions a server/sandbox
3. Installs the agent + dependencies
4. Gets your OpenRouter API key (OAuth or manual)
5. Injects OpenRouter env vars into the shell
6. Drops you into an interactive session

## Non-Interactive Mode

Skip all prompts by setting env vars:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
{CLOUD_NAME_VAR}=dev-mk1 \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/{cloud}/claude.sh)
```

See each cloud's [README](sprite/README.md) for provider-specific env vars.

## Self-Improving

```bash
./improve.sh              # agent team fills gaps + discovers new agents/clouds
./improve.sh --loop       # continuous improvement cycles
```

Uses [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) to coordinate parallel work.
