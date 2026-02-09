# Latitude.sh

Bare metal and VM cloud servers via REST API. [Latitude.sh](https://www.latitude.sh/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/plandex.sh)
```

## Non-Interactive Mode

```bash
LATITUDE_SERVER_NAME=dev-mk1 \
LATITUDE_API_KEY=your-api-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/latitude/claude.sh)
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LATITUDE_API_KEY` | Latitude.sh API key (required) |
| `LATITUDE_SERVER_NAME` | Server hostname (prompted if not set) |
| `LATITUDE_PROJECT_ID` | Project ID (auto-detected from first project) |
| `LATITUDE_PLAN` | Server plan (default: `vm.tiny`) |
| `LATITUDE_SITE` | Data center site (default: `DAL2`) |
| `LATITUDE_OS` | Operating system (default: `ubuntu_24_04_x64_lts`) |
| `OPENROUTER_API_KEY` | OpenRouter API key for agent access |

## Available Plans

| Plan | Specs | Price |
|------|-------|-------|
| `vm.tiny` | 4 vCPUs, 8GB RAM | $0.07/hr |
| `vm.small` | 8 vCPUs, 16GB RAM | $0.14/hr |
| `vm.medium` | 12 vCPUs, 24GB RAM | $0.25/hr |
| `m4.metal.small` | AMD 4244P (6 cores), 64GB RAM | $0.37/hr |

## Available Sites

US (Dallas, LAX, NYC, Chicago, Ashburn, Miami, Silicon Valley), Brazil, Australia, Chile, Japan, Mexico, UK, Germany, Argentina, Colombia, Singapore, Netherlands.

Get your API key at: https://www.latitude.sh/dashboard (Settings & Billing -> API Keys)
