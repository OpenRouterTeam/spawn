#!/bin/bash
# Common bash functions for Fly.io spawn scripts
#
# NOTE: The Fly.io provider has been migrated to TypeScript (fly/main.ts).
# This file provides bash-level helpers and satisfies the shared
# test/source-chain contract. The TypeScript code in fly/lib/*.ts
# handles the actual orchestration.

set -eo pipefail

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# ============================================================
# Fly.io specific configuration
# ============================================================

readonly FLY_API_BASE="https://api.machines.dev/v1"
SPAWN_DASHBOARD_URL="https://fly.io/dashboard"

# Ensure OPENROUTER_API_KEY is available to the TypeScript runtime
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

# ============================================================
# Fly.io authentication
# ============================================================

# Ensure the fly CLI is installed
ensure_fly_cli() {
    if command -v fly &>/dev/null || command -v flyctl &>/dev/null; then
        return 0
    fi
    log_step "Installing flyctl..."
    curl -L https://fly.io/install.sh | sh 2>/dev/null
    export PATH="$HOME/.fly/bin:$PATH"
}

# Authenticate with Fly.io via CLI or token
# Uses ensure_api_token_with_provider pattern for env-based tokens,
# falls back to fly auth login for interactive CLI auth
ensure_fly_token() {
    local token="${FLY_API_TOKEN:-}"
    if [[ -n "$token" ]]; then
        validate_api_token "$token"
        return 0
    fi
    fly auth login
}

# ============================================================
# Fly.io server operations (bash wrappers around fly CLI)
# ============================================================

# Run a command on a Fly machine via fly machine exec
run_server() {
    local app_name="$1"
    local machine_id="$2"
    local cmd="$3"
    fly machine exec "$machine_id" --app "$app_name" -- bash -c "$cmd"
}

# Upload a file to a Fly machine using base64 encoding for safety
# SECURITY: Strict path validation + base64 content encoding to prevent injection
upload_file() {
    local app_name="$1"
    local machine_id="$2"
    local local_path="$3"
    local remote_path="$4"

    # SECURITY: Strict allowlist validation — only safe path characters [a-zA-Z0-9/_.~-]
    if [[ ! "$remote_path" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path: $remote_path"
        return 1
    fi

    local content
    content=$(base64 < "$local_path" | tr -d '\n')
    fly machine exec "$machine_id" --app "$app_name" -- \
        bash -c "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Start an interactive session on a Fly machine
interactive_session() {
    local app_name="$1"
    fly ssh console --app "$app_name"
}

# Destroy a Fly machine
destroy_server() {
    local app_name="$1"
    fly apps destroy "$app_name" --yes
}

# Get the server/app name for Fly
get_server_name() {
    printf '%s' "${SPAWN_SERVER_NAME:-spawn-fly}"
}

# Post-session summary for exec-based clouds (called after interactive session)
fly_post_session() {
    _show_exec_post_session_summary
}
