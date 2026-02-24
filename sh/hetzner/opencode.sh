#!/bin/bash
set -eo pipefail

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    curl -fsSL --show-error https://bun.sh/install | bash >/dev/null
    export PATH="$HOME/.bun/bin:$PATH"
}
_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../packages/cli/src/hetzner/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/../../packages/cli/src/hetzner/main.ts" opencode "$@"
fi

HETZNER_JS=$(mktemp)
trap 'rm -f "$HETZNER_JS"' EXIT
curl -fsSL "https://github.com/OpenRouterTeam/spawn/releases/download/hetzner-latest/hetzner.js" -o "$HETZNER_JS"
exec bun run "$HETZNER_JS" opencode "$@"
