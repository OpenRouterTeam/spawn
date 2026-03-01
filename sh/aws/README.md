# AWS Lightsail

AWS Lightsail instances via AWS CLI. [AWS Lightsail](https://aws.amazon.com/lightsail/)

## Prerequisites

1. **Enable AWS Lightsail** — New AWS accounts must activate Lightsail before first use. Visit the [Lightsail console](https://lightsail.aws.amazon.com/ls/webapp/home) and follow the activation prompt. Without this step, all provisioning commands will fail.

2. **AWS CLI installed and configured** — Run `aws configure` with your Access Key ID and Secret Access Key.

> Uses `ubuntu` user instead of `root`.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/kilocode.sh)
```

#### Hermes Agent

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/hermes.sh)
```

## Non-Interactive Mode

```bash
LIGHTSAIL_SERVER_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/claude.sh)
```
