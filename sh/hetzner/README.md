# Hetzner Cloud

Hetzner Cloud servers via REST API. [Hetzner Cloud](https://www.hetzner.com/cloud/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/openclaw.sh)
```

#### ZeroClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/zeroclaw.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/codex.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/opencode.sh)
```

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/kilocode.sh)
```

#### Hermes

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/hermes.sh)
```

## Non-Interactive Mode

```bash
HETZNER_SERVER_NAME=dev-mk1 \
HCLOUD_TOKEN=your-token \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/hetzner/claude.sh)
```
