#!/bin/bash
set -eo pipefail

# Thin shim: ensures bun is available, runs bundled digitalocean.js (local or from GitHub release)
# Includes SIGTERM trapping + restart loop to handle unexpected termination on DigitalOcean

_AGENT_NAME="codex"
_GOT_SIGTERM=0
_MAX_RETRIES=3
_CHILD_PID=""

_log_signal() {
    printf '\033[0;33m[spawn/%s] Received %s (pid %s) at %s\033[0m\n' \
        "$_AGENT_NAME" "$1" "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" >&2
}

_sigterm_handler() {
    _GOT_SIGTERM=1
    _log_signal "SIGTERM"
    printf '\033[0;33m[spawn/%s] Agent process is being terminated. The droplet is likely still running.\033[0m\n' "$_AGENT_NAME" >&2
    printf '\033[0;33m[spawn/%s] Check your DigitalOcean dashboard: https://cloud.digitalocean.com/droplets\033[0m\n' "$_AGENT_NAME" >&2
    if [[ -n "$_CHILD_PID" ]]; then
        kill -TERM "$_CHILD_PID" 2>/dev/null || true
    fi
}

_sighup_handler() {
    _log_signal "SIGHUP"
    printf '\033[0;33m[spawn/%s] Terminal connection lost. Agent process will exit.\033[0m\n' "$_AGENT_NAME" >&2
    if [[ -n "$_CHILD_PID" ]]; then
        kill -HUP "$_CHILD_PID" 2>/dev/null || true
    fi
    exit 129
}

trap '_sigterm_handler' TERM
trap '_sighup_handler' HUP

_ensure_bun() {
    if command -v bun &>/dev/null; then return 0; fi
    printf '\033[0;36mInstalling bun...\033[0m\n' >&2
    curl -fsSL --show-error https://bun.sh/install | bash >/dev/null || { printf '\033[0;31mFailed to install bun\033[0m\n' >&2; exit 1; }
    export PATH="$HOME/.bun/bin:$PATH"
    command -v bun &>/dev/null || { printf '\033[0;31mbun not found after install\033[0m\n' >&2; exit 1; }
}

_run_with_restart() {
    local attempt=0
    local backoff=2
    while [ "$attempt" -lt "$_MAX_RETRIES" ]; do
        attempt=$((attempt + 1))
        _GOT_SIGTERM=0

        "$@" &
        _CHILD_PID=$!
        wait "$_CHILD_PID" 2>/dev/null
        local exit_code=$?
        _CHILD_PID=""

        # Normal exit — do not restart
        if [ "$exit_code" -eq 0 ]; then
            return 0
        fi

        # If killed by SIGTERM, log and attempt restart (unless max retries reached)
        if [ "$_GOT_SIGTERM" -eq 1 ]; then
            if [ "$attempt" -lt "$_MAX_RETRIES" ]; then
                printf '\033[0;33m[spawn/%s] Restarting after SIGTERM (attempt %s/%s, backoff %ss)...\033[0m\n' \
                    "$_AGENT_NAME" "$((attempt + 1))" "$_MAX_RETRIES" "$backoff" >&2
                sleep "$backoff"
                backoff=$((backoff * 2))
                continue
            else
                printf '\033[0;31m[spawn/%s] Max restart attempts reached (%s). Giving up.\033[0m\n' \
                    "$_AGENT_NAME" "$_MAX_RETRIES" >&2
                return 143
            fi
        fi

        # Non-SIGTERM failure — exit with the original code
        return "$exit_code"
    done
}

_ensure_bun

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# Local checkout — run from source
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../packages/cli/src/digitalocean/main.ts" ]]; then
    _run_with_restart bun run "$SCRIPT_DIR/../../packages/cli/src/digitalocean/main.ts" "$_AGENT_NAME" "$@"
    exit $?
fi

# Remote — download bundled digitalocean.js from GitHub release
DO_JS=$(mktemp)
trap 'rm -f "$DO_JS"; _sigterm_handler' TERM
trap 'rm -f "$DO_JS"; _sighup_handler' HUP
trap 'rm -f "$DO_JS"' EXIT
curl -fsSL "https://github.com/OpenRouterTeam/spawn/releases/download/digitalocean-latest/digitalocean.js" -o "$DO_JS" \
    || { printf '\033[0;31mFailed to download digitalocean.js\033[0m\n' >&2; exit 1; }

_run_with_restart bun run "$DO_JS" "$_AGENT_NAME" "$@"
exit $?
