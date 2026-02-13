# Kamatera

Kamatera cloud servers via REST API. [Kamatera](https://www.kamatera.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/plandex.sh)
```

## Non-Interactive Mode

```bash
KAMATERA_SERVER_NAME=dev-mk1 \
KAMATERA_API_CLIENT_ID=your-client-id \
KAMATERA_API_SECRET=your-api-secret \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/kamatera/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `KAMATERA_API_CLIENT_ID` | Kamatera API Client ID | _(prompted)_ |
| `KAMATERA_API_SECRET` | Kamatera API Secret | _(prompted)_ |
| `KAMATERA_SERVER_NAME` | Server name | _(prompted)_ |
| `KAMATERA_DATACENTER` | Datacenter location | `EU` |
| `KAMATERA_CPU` | CPU type and cores (e.g., `2B`) | `2B` |
| `KAMATERA_RAM` | RAM in MB | `2048` |
| `KAMATERA_DISK` | Disk configuration | `size=20` |
| `KAMATERA_IMAGE` | OS image | `ubuntu_server_24.04_64-bit` |
| `KAMATERA_BILLING` | Billing cycle (`hourly` or `monthly`) | `hourly` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(prompted via OAuth)_ |
