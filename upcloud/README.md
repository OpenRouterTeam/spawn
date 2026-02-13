# UpCloud

UpCloud cloud servers via REST API. [UpCloud](https://upcloud.com/)

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/claude.sh)
```

#### OpenClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/openclaw.sh)
```

#### NanoClaw

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/nanoclaw.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/goose.sh)
```

#### Codex CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/codex.sh)
```

#### Open Interpreter

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/interpreter.sh)
```

#### Gemini CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/gemini.sh)
```

#### Amazon Q CLI

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/amazonq.sh)
```

#### Cline

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/cline.sh)
```

#### gptme

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/gptme.sh)
```

#### OpenCode

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/opencode.sh)
```

#### Plandex

```bash
bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/plandex.sh)
```

## Non-Interactive Mode

```bash
UPCLOUD_SERVER_NAME=dev-mk1 \
UPCLOUD_USERNAME=your-api-username \
UPCLOUD_PASSWORD=your-api-password \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/labs/spawn/upcloud/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `UPCLOUD_USERNAME` | UpCloud API username | _(prompted)_ |
| `UPCLOUD_PASSWORD` | UpCloud API password | _(prompted)_ |
| `UPCLOUD_SERVER_NAME` | Server name | _(prompted)_ |
| `UPCLOUD_ZONE` | Datacenter zone | `de-fra1` |
| `UPCLOUD_PLAN` | Server plan | `1xCPU-2GB` |
| `OPENROUTER_API_KEY` | OpenRouter API key | _(OAuth or prompted)_ |
