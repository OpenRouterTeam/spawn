#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled sprite.js (local or from GitHub release)

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL --show-error https://bun.sh/install | bash >/dev/null || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# SPAWN_CLI_DIR override — force local source (used by e2e tests)
if [[ -n "${SPAWN_CLI_DIR:-}" && -f "$SPAWN_CLI_DIR/packages/cli/src/sprite/main.ts" ]]; then
    exec bun run "$SPAWN_CLI_DIR/packages/cli/src/sprite/main.ts" opencode "$@"
fi

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../packages/cli/src/sprite/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/../../packages/cli/src/sprite/main.ts" opencode "$@"
fi

# Remote — download bundled sprite.js from GitHub release
SPRITE_JS=$(mktemp)
trap 'rm -f "$SPRITE_JS"' EXIT
curl -fsSL "https://github.com/OpenRouterTeam/spawn/releases/download/sprite-latest/sprite.js" -o "$SPRITE_JS" \
    || { printf '\033[0;31mFailed to download sprite.js\033[0m\n' >&2; exit 1; }

exec bun run "$SPRITE_JS" opencode "$@"
