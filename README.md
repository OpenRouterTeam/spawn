# Spawn

Automated sprite provisioning scripts for various tools and configurations.

## Usage

### OpenClaw Setup

Setup a sprite with openclaw pre-configured:

```bash
curl https://openrouter.ai/lab/spawn/sprite/openclaw.sh | bash
```

This will:
1. Install sprite CLI if not present
2. Login to sprite to get credentials
3. Provision a new sprite with the specified name
4. Add `bun` to PATH
5. Install openclaw using bun
6. Open openrouter.ai/settings/keys to grab an API key
7. Inject API keys (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
8. Configure openclaw to bypass initial settings

## Development

To test locally:

```bash
bash sprite/openclaw.sh
```

## Deployment

These scripts are served from `openrouter.ai/lab/spawn/*` via Next.js rewrites configured in `openrouter-web/projects/web/next.config.mjs`.
