# GCP Compute Engine

Google Cloud Compute Engine instances via gcloud CLI. [GCP Compute Engine](https://cloud.google.com/compute)

> Uses current username for SSH. Requires gcloud CLI installed and configured.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/kilocode.sh)
```

## Non-Interactive Mode

```bash
GCP_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/claude.sh)
```
