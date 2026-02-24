#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled local.js (local or from GitHub release)

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL --show-error https://bun.sh/install | bash >/dev/null || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../packages/cli/src/local/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/../../packages/cli/src/local/main.ts" openclaw "$@"
fi

# Remote — download bundled local.js from GitHub release
LOCAL_JS=$(mktemp)
trap 'rm -f "$LOCAL_JS"' EXIT
curl -fsSL "https://github.com/OpenRouterTeam/spawn/releases/download/local-latest/local.js" -o "$LOCAL_JS" \
    || { printf '\033[0;31mFailed to download local.js\033[0m\n' >&2; exit 1; }

exec bun run "$LOCAL_JS" openclaw "$@"
