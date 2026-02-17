#!/bin/bash
# Common bash functions for Fly.io spawn scripts
# Uses Fly.io Machines API + flyctl CLI for provisioning and SSH access

# Bash safety flags
set -eo pipefail

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# Fly.io specific functions
# ============================================================

readonly FLY_API_BASE="https://api.machines.dev/v1"
SPAWN_DASHBOARD_URL="https://fly.io/dashboard"

# Centralized curl wrapper for Fly.io Machines API
# Handles both token formats:
#   - FlyV1 tokens (from dashboard/fly tokens create): Authorization: FlyV1 fm2_...
#   - Legacy tokens (from fly auth token): Authorization: Bearer <token>
fly_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    if [[ "$FLY_API_TOKEN" == FlyV1\ * ]]; then
        generic_cloud_api_custom_auth "$FLY_API_BASE" "$method" "$endpoint" "$body" 3 -H "Authorization: $FLY_API_TOKEN"
    else
        generic_cloud_api "$FLY_API_BASE" "$FLY_API_TOKEN" "$method" "$endpoint" "$body"
    fi
}

# Resolve the flyctl CLI command name ("fly" or "flyctl")
# Prints the command name on stdout; returns 1 if neither is found
_get_fly_cmd() {
    if command -v fly &>/dev/null; then
        echo "fly"
    elif command -v flyctl &>/dev/null; then
        echo "flyctl"
    else
        return 1
    fi
}

# Parse the "error" field from a Fly.io API JSON response
# Usage: echo "$response" | _fly_parse_error [DEFAULT]
_fly_parse_error() {
    local default="${1:-Unknown error}"
    python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',sys.argv[1]))" "$default" 2>/dev/null || cat
}

# Ensure flyctl CLI is installed
ensure_fly_cli() {
    if _get_fly_cmd &>/dev/null; then
        log_info "flyctl CLI available"
        return 0
    fi

    log_step "Installing flyctl CLI..."
    curl -L https://fly.io/install.sh | sh 2>/dev/null || {
        log_error "Failed to install flyctl CLI"
        log_error "Install manually: curl -L https://fly.io/install.sh | sh"
        return 1
    }

    # Add to PATH if installed to ~/.fly/bin
    if [[ -d "$HOME/.fly/bin" ]]; then
        export PATH="$HOME/.fly/bin:$PATH"
    fi

    if ! _get_fly_cmd &>/dev/null; then
        log_error "flyctl not found in PATH after installation"
        return 1
    fi

    log_info "flyctl CLI installed"
}

# Ensure FLY_API_TOKEN is available (env var -> config file -> flyctl CLI -> prompt+save)

# Try to get token from flyctl CLI if available
_try_flyctl_auth() {
    local fly_cmd
    fly_cmd=$(_get_fly_cmd) || return 1

    local token
    token=$("$fly_cmd" auth token 2>/dev/null || true)
    if [[ -n "$token" ]]; then
        echo "$token"
        return 0
    fi
    return 1
}

# Validate a Fly.io token by making a test API call
_validate_fly_token() {
    local response
    response=$(fly_api GET "/apps?org_slug=personal")
    if echo "$response" | grep -q '"error"'; then
        log_error "Authentication failed: Invalid Fly.io API token"
        log_error "API Error: $(echo "$response" | _fly_parse_error "No details available")"
        log_error "How to fix:"
        log_warn "  1. Run: fly tokens deploy"
        log_warn "  2. Or generate a token at: https://fly.io/dashboard"
        log_warn "  3. Ensure the token has appropriate permissions"
        return 1
    fi
    return 0
}

ensure_fly_token() {
    # Try flyctl CLI auth first (unique to Fly.io), then fall through to generic flow
    if [[ -z "${FLY_API_TOKEN:-}" ]]; then
        local token
        token=$(_try_flyctl_auth 2>/dev/null) && {
            export FLY_API_TOKEN="$token"
            log_info "Using Fly.io API token from flyctl auth"
            _save_token_to_config "$HOME/.config/spawn/fly.json" "$token"
            return 0
        }
    fi

    ensure_api_token_with_provider \
        "Fly.io" \
        "FLY_API_TOKEN" \
        "$HOME/.config/spawn/fly.json" \
        "https://fly.io/dashboard → Tokens" \
        "_validate_fly_token"
}

# Get the Fly.io org slug (default: personal)
get_fly_org() {
    echo "${FLY_ORG:-personal}"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "FLY_APP_NAME" "Enter app name: "
}

# Create Fly.io app, returning 0 on success or if app already exists
_fly_create_app() {
    local name="$1"
    local org
    org=$(get_fly_org)

    # SECURITY: Validate org slug to prevent JSON injection via FLY_ORG env var
    if [[ ! "$org" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid FLY_ORG: must be alphanumeric with hyphens/underscores only"
        return 1
    fi

    log_step "Creating Fly.io app '$name'..."
    # SECURITY: Use json_escape to prevent JSON injection
    local app_body
    app_body=$(printf '{"app_name":%s,"org_slug":%s}' "$(json_escape "$name")" "$(json_escape "$org")")
    local response
    response=$(fly_api POST "/apps" "$app_body")

    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | _fly_parse_error)
        if echo "$error_msg" | grep -qi "already exists"; then
            log_info "App '$name' already exists, reusing it"
            return 0
        fi
        log_error "Failed to create Fly.io app"
        log_error "API Error: $error_msg"
        log_warn "Common issues:"
        log_warn "  - App name already taken by another user"
        log_warn "  - Invalid organization slug"
        log_warn "  - API token lacks permissions"
        return 1
    fi

    log_info "App '$name' created"
}

# Build JSON request body for Fly.io machine creation
# SECURITY: Pass values via environment variables to prevent Python injection
_fly_build_machine_body() {
    local name="$1" region="$2" vm_memory="$3"
    _FLY_NAME="$name" _FLY_REGION="$region" _FLY_MEM="$vm_memory" python3 -c "
import json, os
body = {
    'name': os.environ['_FLY_NAME'],
    'region': os.environ['_FLY_REGION'],
    'config': {
        'image': 'ubuntu:24.04',
        'guest': {
            'cpu_kind': 'shared',
            'cpus': 1,
            'memory_mb': int(os.environ['_FLY_MEM'])
        },
        'init': {
            'exec': ['/bin/sleep', 'inf']
        },
        'auto_destroy': False
    }
}
print(json.dumps(body))
"
}

# Create a Fly.io machine via the Machines API
# Sets FLY_MACHINE_ID and FLY_APP_NAME on success
_fly_create_machine() {
    local name="$1"
    local region="$2"
    local vm_memory="$3"

    log_step "Creating Fly.io machine (region: $region, memory: ${vm_memory}MB)..."

    local machine_body
    machine_body=$(_fly_build_machine_body "$name" "$region" "$vm_memory")

    local response
    response=$(fly_api POST "/apps/$name/machines" "$machine_body")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create Fly.io machine"
        log_error "API Error: $(echo "$response" | _fly_parse_error)"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Region unavailable (try different FLY_REGION)"
        log_warn "  - Machine limit reached"
        log_warn "Check your dashboard: https://fly.io/dashboard"
        return 1
    fi

    FLY_MACHINE_ID=$(_extract_json_field "$response" "d['id']")
    if [[ -z "$FLY_MACHINE_ID" ]]; then
        log_error "Failed to extract machine ID from API response"
        log_error "Response: $response"
        return 1
    fi
    export FLY_MACHINE_ID FLY_APP_NAME="$name"
    log_info "Machine created: ID=$FLY_MACHINE_ID, App=$name"
}

# Wait for a Fly.io machine to reach "started" state
# Usage: _fly_wait_for_machine_start APP_NAME MACHINE_ID [MAX_ATTEMPTS]
_fly_wait_for_machine_start() {
    local name="$1"
    local machine_id="$2"
    local max_attempts="${3:-30}"
    local attempt=1

    log_step "Waiting for machine to start..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local state
        state=$(_extract_json_field "$(fly_api GET "/apps/$name/machines/$machine_id")" "d.get('state','unknown')")

        if [[ "$state" == "started" ]]; then
            log_info "Machine is running"
            return 0
        fi

        log_step "Machine state: $state ($attempt/$max_attempts)"
        sleep 3
        attempt=$((attempt + 1))
    done

    log_error "Machine did not start after $max_attempts attempts"
    log_error ""
    log_error "The machine may still be starting. You can:"
    log_error "  1. Check status: fly machines list -a $name"
    log_error "  2. Try a different region: FLY_REGION=ord (Chicago), FLY_REGION=ams (Amsterdam)"
    log_error "  3. View in dashboard: https://fly.io/dashboard"
    return 1
}

# Create a Fly.io app and machine
create_server() {
    local name="$1"
    local region="${FLY_REGION:-iad}"
    local vm_size="${FLY_VM_SIZE:-shared-cpu-1x}"
    local vm_memory="${FLY_VM_MEMORY:-1024}"

    # Validate env var inputs to prevent injection into Python code
    validate_region_name "$region" || { log_error "Invalid FLY_REGION"; return 1; }
    validate_resource_name "$vm_size" || { log_error "Invalid FLY_VM_SIZE"; return 1; }
    if [[ ! "$vm_memory" =~ ^[0-9]+$ ]]; then log_error "Invalid FLY_VM_MEMORY: must be numeric"; return 1; fi

    _fly_create_app "$name" || return 1
    _fly_create_machine "$name" "$region" "$vm_memory" || return 1
    _fly_wait_for_machine_start "$name" "$FLY_MACHINE_ID"

    save_vm_connection "fly-ssh" "root" "${FLY_MACHINE_ID}" "$name" "fly"
}

# Wait for base tools to be installed (Fly.io uses bare Ubuntu image)
wait_for_cloud_init() {
    log_step "Installing base tools on Fly.io machine..."
    run_server "apt-get update -y && apt-get install -y curl unzip git zsh python3 pip" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# Run a command on the Fly.io machine via flyctl ssh
run_server() {
    local cmd="$1"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    "$(_get_fly_cmd)" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd" --quiet 2>/dev/null
}

# Upload a file to the machine via base64 encoding through exec
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    # base64 output is safe (alphanumeric + /+=) so no injection risk
    local content
    content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")

    run_server "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Start an interactive SSH session on the Fly.io machine
interactive_session() {
    local cmd="$1"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    local session_exit=0
    "$(_get_fly_cmd)" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd" || session_exit=$?
    SERVER_NAME="${FLY_APP_NAME:-}" SPAWN_RECONNECT_CMD="fly ssh console -a ${FLY_APP_NAME:-}" \
        _show_exec_post_session_summary
    return "${session_exit}"
}

# Destroy a Fly.io machine and app
destroy_server() {
    local app_name="${1:-$FLY_APP_NAME}"

    log_step "Destroying Fly.io app and machines for '$app_name'..."

    # List and destroy all machines in the app
    local machines
    machines=$(fly_api GET "/apps/$app_name/machines")
    local machine_ids
    machine_ids=$(echo "$machines" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    for m in data:
        print(m['id'])
" 2>/dev/null || true)

    for mid in $machine_ids; do
        log_step "Stopping machine $mid..."
        fly_api POST "/apps/$app_name/machines/$mid/stop" '{}' >/dev/null 2>&1 || true
        sleep 2
        log_step "Destroying machine $mid..."
        fly_api DELETE "/apps/$app_name/machines/$mid?force=true" >/dev/null 2>&1 || true
    done

    # Delete the app
    fly_api DELETE "/apps/$app_name" >/dev/null 2>&1 || true
    log_info "App '$app_name' destroyed"
}

# Inject environment variables into both .bashrc and .zshrc (Fly.io specific)
# Fly uses both bash and zsh, so we append to both rc files
# Usage: inject_env_vars_fly KEY1=VAL1 KEY2=VAL2 ...
inject_env_vars_fly() {
    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Append to .bashrc and .zshrc only
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> ~/.bashrc && cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

    # Note: temp file will be cleaned up by trap handler
}

# List all Fly.io apps and machines
list_servers() {
    local org=$(get_fly_org)
    local response=$(fly_api GET "/apps?org_slug=$org")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
apps = data if isinstance(data, list) else data.get('apps', [])
if not apps:
    print('No apps found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<20} {'STATUS':<12} {'NETWORK':<20}\")
print('-' * 77)
for a in apps:
    name = a.get('name', 'N/A')
    aid = a.get('id', 'N/A')
    status = a.get('status', 'N/A')
    network = a.get('network', 'N/A')
    print(f'{name:<25} {aid:<20} {status:<12} {network:<20}')
" <<< "$response"
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_fly_cli; ensure_fly_token; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { wait_for_cloud_init; }
cloud_run() { run_server "$1"; }
cloud_upload() { upload_file "$1" "$2"; }
cloud_interactive() { interactive_session "$1"; }
cloud_label() { echo "Fly.io machine"; }
