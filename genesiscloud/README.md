# Genesis Cloud

Genesis Cloud GPU instances via REST API. [Genesis Cloud](https://www.genesiscloud.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/aider.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/plandex.sh)
```

## Non-Interactive Mode

```bash
GENESIS_SERVER_NAME=dev-gpu \
GENESIS_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/genesiscloud/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENESIS_API_KEY` | Genesis Cloud API key | _(prompted)_ |
| `GENESIS_SERVER_NAME` | Instance name | _(prompted)_ |
| `GENESIS_INSTANCE_TYPE` | Instance type | `vcpu-4_memory-12g_nvidia-rtx-3080-1` |
| `GENESIS_REGION` | Datacenter region | `ARC-IS-HAF-1` |
| `GENESIS_IMAGE` | OS image | `Ubuntu 24.04` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |
