# Atlantic.Net Cloud

Atlantic.Net Cloud servers via REST API. [Atlantic.Net](https://www.atlantic.net/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/aider.sh)
```

#### OpenClaw

#### Kilo Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/kilocode.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/openclaw.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/interpreter.sh)
```

#### Codex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/codex.sh)
```

#### Continue

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/continue.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/gptme.sh)
```

#### Gemini

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/gemini.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/plandex.sh)
```

#### Amazon Q

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/amazonq.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/goose.sh)
```

## Non-Interactive Mode

```bash
ATLANTICNET_SERVER_NAME=dev-mk1 \
ATLANTICNET_API_KEY=your-api-key \
ATLANTICNET_API_PRIVATE_KEY=your-private-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/atlanticnet/claude.sh)
```

## Environment Variables

- `ATLANTICNET_API_KEY` - API Access Key ID (get from https://cloud.atlantic.net/ → API Info)
- `ATLANTICNET_API_PRIVATE_KEY` - API Private Key
- `ATLANTICNET_SERVER_NAME` - Custom server name (default: random)
- `ATLANTICNET_PLAN` - Server plan (default: G2.2GB)
- `ATLANTICNET_IMAGE` - OS image ID (default: ubuntu-24.04_64bit)
- `ATLANTICNET_LOCATION` - Data center location (default: USEAST2)
- `OPENROUTER_API_KEY` - OpenRouter API key for agent access

## Available Locations

- USEAST1 - Ashburn, VA
- USEAST2 - Orlando, FL (default)
- USCENTRAL1 - Dallas, TX
- USWEST1 - San Francisco, CA
- CAEAST1 - Toronto, ON, Canada
