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

#### Hermes

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/hermes.sh)
```

#### Junie

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/junie.sh)
```

#### Cursor CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/cursor.sh)
```

#### Pi

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/pi.sh)
```

#### T3 Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/t3code.sh)
```

## Non-Interactive Mode

```bash
GCP_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/claude.sh)
```

## Custom Disk Size

By default, instances are created with a **40 GB** boot disk. Override with `GCP_DISK_SIZE` (in GB):

| Variable | Default | Description |
|---|---|---|
| `GCP_DISK_SIZE` | `40` | Boot disk size in GB |

```bash
GCP_DISK_SIZE=80 \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/claude.sh)
```

## Custom VPC / Subnet

If your GCP project's default VPC uses **custom subnet mode** (common in enterprise or org-managed projects), set these env vars to override the default network/subnet:

| Variable | Default | Description |
|---|---|---|
| `GCP_NETWORK` | `default` | VPC network name |
| `GCP_SUBNET` | `default` | Subnet name |

Example:
```bash
GCP_NETWORK=my-vpc GCP_SUBNET=my-subnet \
GCP_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/gcp/claude.sh)
```
