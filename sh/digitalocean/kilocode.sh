#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled digitalocean.js (local or from GitHub release)
# Includes restart loop for SIGTERM recovery on DigitalOcean

_AGENT_NAME="kilocode"
_MAX_RETRIES=3

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL --proto '=https' --show-error https://bun.sh/install | bash >/dev/null || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

# Run command in the foreground so bun gets full terminal access (raw mode,
# arrow keys for interactive prompts).  The old pattern backgrounded the child
# with & + wait so a SIGTERM trap could forward the signal, but that removed
# bun from the foreground process group and broke @clack/prompts multiselect.
# Now SIGTERM is detected from exit code 143 (128 + 15) after the child exits.
_run_with_restart() {
    local attempt=0
    local backoff=2
    while [ "$attempt" -lt "$_MAX_RETRIES" ]; do
        attempt=$((attempt + 1))

        "$@"
        local exit_code=$?

        # Normal exit
        if [ "$exit_code" -eq 0 ]; then
            return 0
        fi

        # SIGTERM (143) or SIGKILL (137) — attempt restart
        if [ "$exit_code" -eq 143 ] || [ "$exit_code" -eq 137 ]; then
            printf '\033[0;33m[spawn/%s] Agent process terminated (exit %s). The droplet is likely still running.\033[0m\n' \
                "$_AGENT_NAME" "$exit_code" >&2
            printf '\033[0;33m[spawn/%s] Check your DigitalOcean dashboard: https://cloud.digitalocean.com/droplets\033[0m\n' \
                "$_AGENT_NAME" >&2
            if [ "$attempt" -lt "$_MAX_RETRIES" ]; then
                printf '\033[0;33m[spawn/%s] Restarting (attempt %s/%s, backoff %ss)...\033[0m\n' \
                    "$_AGENT_NAME" "$((attempt + 1))" "$_MAX_RETRIES" "$backoff" >&2
                sleep "$backoff"
                backoff=$((backoff * 2))
                continue
            else
                printf '\033[0;31m[spawn/%s] Max restart attempts reached (%s). Giving up.\033[0m\n' \
                    "$_AGENT_NAME" "$_MAX_RETRIES" >&2
                return "$exit_code"
            fi
        fi

        # Other failure — exit with the original code
        return "$exit_code"
    done
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# SPAWN_CLI_DIR override — force local source (used by e2e tests)
if [[ -n "${SPAWN_CLI_DIR:-}" && -f "$SPAWN_CLI_DIR/packages/cli/src/digitalocean/main.ts" ]]; then
    _run_with_restart bun run "$SPAWN_CLI_DIR/packages/cli/src/digitalocean/main.ts" "$_AGENT_NAME" "$@"
    exit $?
fi

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../packages/cli/src/digitalocean/main.ts" ]]; then
    _run_with_restart bun run "$SCRIPT_DIR/../../packages/cli/src/digitalocean/main.ts" "$_AGENT_NAME" "$@"
    exit $?
fi

# Remote — download bundled digitalocean.js from GitHub release
DO_JS=$(mktemp)
trap 'rm -f "$DO_JS"' EXIT
curl -fsSL --proto '=https' "https://github.com/OpenRouterTeam/spawn/releases/download/digitalocean-latest/digitalocean.js" -o "$DO_JS" \
    || { printf '\033[0;31mFailed to download digitalocean.js\033[0m\n' >&2; exit 1; }

_run_with_restart bun run "$DO_JS" "$_AGENT_NAME" "$@"
exit $?
