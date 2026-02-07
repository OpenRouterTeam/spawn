# Lambda Cloud

Lambda GPU Cloud instances via REST API. [Lambda Cloud](https://lambdalabs.com/)

> GPU cloud, uses 'ubuntu' user. Manual tool install (no cloud-init).

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/cline.sh)
```

## Non-Interactive Mode

```bash
LAMBDA_SERVER_NAME=dev-mk1 \
LAMBDA_API_KEY=your-key \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/lambda/claude.sh)
```
