# AWS Lightsail

AWS Lightsail instances via AWS CLI. [AWS Lightsail](https://aws.amazon.com/lightsail/)

> Uses 'ubuntu' user instead of 'root'. Requires AWS CLI installed and configured.

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

## Non-Interactive Mode

```bash
LIGHTSAIL_SERVER_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/aws/claude.sh)
```
