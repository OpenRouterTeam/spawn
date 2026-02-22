#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled daytona TypeScript (local or from GitHub release)

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../cli/src/daytona/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/../cli/src/daytona/main.ts" opencode "$@"
fi

# Remote — download bundled daytona.js from GitHub release
DAYTONA_JS=$(mktemp)
trap 'rm -f "$DAYTONA_JS"' EXIT
curl -fsSL "https://github.com/OpenRouterTeam/spawn/releases/download/daytona-latest/daytona.js" -o "$DAYTONA_JS" \
    || { printf '\033[0;31mFailed to download daytona.js\033[0m\n' >&2; exit 1; }

exec bun run "$DAYTONA_JS" opencode "$@"
