#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, downloads TS sources if needed, runs main.ts

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/main.ts" ]]; then
    exec bun run "$SCRIPT_DIR/main.ts" codex "$@"
fi

REMOTE_BASE="https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/fly"
TMPDIR_TS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TS"' EXIT

mkdir -p "$TMPDIR_TS/lib"
for f in main.ts lib/fly.ts lib/oauth.ts lib/agents.ts lib/ui.ts; do
    curl -fsSL "$REMOTE_BASE/$f" -o "$TMPDIR_TS/$f" || { printf '\033[0;31mFailed to download %s\033[0m\n' "$f" >&2; exit 1; }
done

exec bun run "$TMPDIR_TS/main.ts" codex "$@"
