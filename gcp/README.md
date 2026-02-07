# GCP Compute Engine

Google Cloud Compute Engine instances via gcloud CLI. [GCP Compute Engine](https://cloud.google.com/compute)

> Uses current username for SSH. Requires gcloud CLI installed and configured.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/cline.sh)
```

## Non-Interactive Mode

```bash
GCP_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/gcp/claude.sh)
```
