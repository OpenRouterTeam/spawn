# GitHub Codespaces

GitHub Codespaces development environments via gh CLI. [GitHub Codespaces](https://github.com/features/codespaces)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/github-codespaces/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/github-codespaces/aider.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/github-codespaces/gptme.sh)
```

## Non-Interactive Mode

```bash
GITHUB_REPO=OpenRouterTeam/spawn \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/github-codespaces/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_REPO` | Repository for codespace | `OpenRouterTeam/spawn` |
| `CODESPACE_MACHINE` | Machine type | `basicLinux32gb` |
| `CODESPACE_IDLE_TIMEOUT` | Idle timeout | `30m` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |

## Pricing

GitHub Codespaces uses pay-as-you-go pricing:

- **Compute**: Starting at $0.18/hr for basicLinux32gb (2 core, 4GB RAM)
- **Storage**: $0.07/GB per month
- **Free tier**: Available for personal accounts (limited hours/month)

See [GitHub Codespaces pricing](https://docs.github.com/en/billing/managing-billing-for-github-codespaces/about-billing-for-github-codespaces) for details.

## Prerequisites

- GitHub CLI (`gh`) installed and authenticated
- Active GitHub account
- Repository access (default: OpenRouterTeam/spawn)

## Machine Types

| Machine | Cores | RAM | Price/hr |
|---------|-------|-----|----------|
| basicLinux32gb | 2 | 4GB | $0.18 |
| standardLinux32gb | 4 | 8GB | $0.36 |
| premiumLinux | 8 | 16GB | $0.72 |
| largePremiumLinux | 16 | 32GB | $1.44 |

Set via `CODESPACE_MACHINE` environment variable.
