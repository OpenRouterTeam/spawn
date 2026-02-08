# Modal

Modal sandboxed containers via Python SDK. [Modal](https://modal.com)

> No SSH — uses Modal Python SDK for exec. Sub-second cold starts. Requires pip install modal.

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/cline.sh)
```

## Non-Interactive Mode

```bash
MODAL_SANDBOX_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/modal/claude.sh)
```
