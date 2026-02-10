# Render

Render is a modern cloud platform for deploying full-stack applications, APIs, and websites. It offers a developer-first experience with automatic deployments, built-in SSL, and managed infrastructure.

## Features

- **Free Hobby Plan**: Free tier for development and small projects
- **Docker Support**: Native Docker container support
- **CLI & SSH Access**: Full CLI tooling with SSH access via `render ssh`
- **REST API**: Comprehensive API for programmatic provisioning
- **Auto Deployments**: Automatic deployments from Git repositories
- **Managed Services**: PostgreSQL, Redis, and other managed services

## Authentication

Render scripts require a `RENDER_API_KEY`. Get yours at: https://dashboard.render.com/u/settings/api-keys

The scripts will:
1. Check for `RENDER_API_KEY` environment variable
2. Fall back to saved key at `~/.config/spawn/render.json`
3. Prompt for the key if neither is available

## Available Agents

### Claude Code

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/claude.sh)
```

Deploys Claude Code with OpenRouter integration. Configures:
- Automatic OpenRouter API base URL
- Bypass permissions mode for autonomous operation
- Dark theme and vim editor settings

### OpenClaw

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/openclaw.sh)
```

Deploys OpenClaw with multi-channel gateway and TUI. Starts gateway in background, then launches interactive TUI. Prompts for model selection (default: `openrouter/auto`).

### NanoClaw

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/nanoclaw.sh)
```

Deploys NanoClaw WhatsApp-based AI agent. Requires WhatsApp QR code scan for authentication.

### Aider

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/aider.sh)
```

Deploys Aider with OpenRouter model routing. Prompts for model selection (default: `openrouter/auto`).

### Goose

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/goose.sh)
```

Deploys Goose AI coding agent by Block with native OpenRouter support.

### Codex CLI

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/codex.sh)
```

Deploys Codex CLI with OpenRouter integration via OPENAI_BASE_URL override.

### Open Interpreter

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/interpreter.sh)
```

Deploys Open Interpreter with OpenRouter integration via OPENAI_BASE_URL override.

### Gemini CLI

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/render/gemini.sh)
```

Deploys Gemini CLI with OpenRouter integration via OPENAI_BASE_URL and GEMINI_API_KEY override.

## Service Details

- **Plan**: Starter (can be configured)
- **Region**: Oregon (default)
- **Runtime**: Docker
- **Base Image**: render-examples/docker-hello-world (minimal Ubuntu with SSH)

## Environment Variables

All scripts support:
- `RENDER_API_KEY`: Your Render API token
- `OPENROUTER_API_KEY`: Your OpenRouter API key (or OAuth flow)

## Cleanup

Services are automatically cleaned up on exit. Manual cleanup:

```bash
render services:delete <service-id>
```

## Limitations

- Render's free Hobby plan has resource limits (512MB RAM, 0.1 CPU)
- Services spin down after 15 minutes of inactivity
- Cold starts take 30-60 seconds

## Links

- Dashboard: https://dashboard.render.com/
- Documentation: https://docs.render.com/
- API Reference: https://api-docs.render.com/
- CLI: https://github.com/render-oss/cli
