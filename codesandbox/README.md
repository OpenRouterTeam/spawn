# CodeSandbox

CodeSandbox Firecracker microVMs via SDK/CLI. [CodeSandbox](https://codesandbox.io)

> No SSH — uses CodeSandbox SDK/CLI for exec. Firecracker microVMs with ~2s start. Free tier: 40 hrs/mo on Build plan. Requires npm install -g @codesandbox/sdk.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/openclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/goose.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/plandex.sh)
```

## Non-Interactive Mode

```bash
CODESANDBOX_SANDBOX_NAME=dev-mk1 \
CSB_API_KEY=csb_xxxxx \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/codesandbox/claude.sh)
```

## Authentication

Get your CodeSandbox API key at: https://codesandbox.io/t/api

Enable all scopes when creating the key and export it as:

```bash
export CSB_API_KEY=your-key-here
```
