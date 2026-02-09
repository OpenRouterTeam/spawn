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

# Centralized curl wrapper for Fly.io Machines API
fly_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$FLY_API_BASE" "$FLY_API_TOKEN" "$method" "$endpoint" "$body"
}

# Ensure flyctl CLI is installed
ensure_fly_cli() {
    if command -v fly &>/dev/null; then
        log_info "flyctl CLI available"
        return 0
    fi
    if command -v flyctl &>/dev/null; then
        log_info "flyctl CLI available (as flyctl)"
        # Create alias function so we can use 'fly' consistently
        fly() { flyctl "$@"; }
        export -f fly
        return 0
    fi

    log_warn "Installing flyctl CLI..."
    curl -L https://fly.io/install.sh | sh 2>/dev/null || {
        log_error "Failed to install flyctl CLI"
        log_error "Install manually: curl -L https://fly.io/install.sh | sh"
        return 1
    }

    # Add to PATH if installed to ~/.fly/bin
    if [[ -d "$HOME/.fly/bin" ]]; then
        export PATH="$HOME/.fly/bin:$PATH"
    fi

    if ! command -v fly &>/dev/null && ! command -v flyctl &>/dev/null; then
        log_error "flyctl not found in PATH after installation"
        return 1
    fi

    log_info "flyctl CLI installed"
}

# Ensure FLY_API_TOKEN is available (env var -> config file -> prompt+save)
# Save Fly.io token to config file
_save_fly_token() {
    local token="$1"
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/fly.json"
    mkdir -p "$config_dir"
    printf '{\n  "token": "%s"\n}\n' "$(json_escape "$token")" > "$config_file"
    chmod 600 "$config_file"
}

# Try to get token from flyctl CLI if available
_try_flyctl_auth() {
    local fly_cmd=""
    if command -v fly &>/dev/null; then
        fly_cmd="fly"
    elif command -v flyctl &>/dev/null; then
        fly_cmd="flyctl"
    else
        return 1
    fi

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
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "Authentication failed: Invalid Fly.io API token"
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Run: fly tokens deploy"
        log_warn "  2. Or generate a token at: https://fly.io/dashboard"
        log_warn "  3. Ensure the token has appropriate permissions"
        return 1
    fi
    return 0
}

ensure_fly_token() {
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        log_info "Using Fly.io API token from environment"
        return 0
    fi

    local config_file="$HOME/.config/spawn/fly.json"

    # 2. Check config file
    if [[ -f "$config_file" ]]; then
        local saved_token
        saved_token=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('token',''))" "$config_file" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export FLY_API_TOKEN="$saved_token"
            log_info "Using Fly.io API token from $config_file"
            return 0
        fi
    fi

    # 3. Try flyctl CLI auth
    local token
    token=$(_try_flyctl_auth) && {
        export FLY_API_TOKEN="$token"
        log_info "Using Fly.io API token from flyctl auth"
        _save_fly_token "$token"
        return 0
    }

    # 4. Prompt and validate
    echo ""
    log_warn "Fly.io API Token Required"
    printf '%b\n' "${YELLOW}Get your token by running: fly tokens deploy${NC}"
    printf '%b\n' "${YELLOW}Or create one at: https://fly.io/dashboard → Tokens${NC}"
    echo ""

    token=$(safe_read "Enter your Fly.io API token: ") || return 1
    if [[ -z "$token" ]]; then
        log_error "API token cannot be empty"
        log_warn "For non-interactive usage, set: FLY_API_TOKEN=your-token"
        return 1
    fi

    export FLY_API_TOKEN="$token"
    if ! _validate_fly_token; then
        unset FLY_API_TOKEN
        return 1
    fi

    _save_fly_token "$token"
    log_info "API token saved to $config_file"
}

# Get the Fly.io org slug (default: personal)
get_fly_org() {
    echo "${FLY_ORG:-personal}"
}

# Get server name from env var or prompt
get_server_name() {
    if [[ -n "${FLY_APP_NAME:-}" ]]; then
        log_info "Using app name from environment: $FLY_APP_NAME"
        if ! validate_server_name "$FLY_APP_NAME"; then
            return 1
        fi
        echo "$FLY_APP_NAME"
        return 0
    fi

    local server_name=$(safe_read "Enter app name: ")
    if [[ -z "$server_name" ]]; then
        log_error "App name is required"
        log_warn "Set FLY_APP_NAME environment variable for non-interactive usage:"
        log_warn "  FLY_APP_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
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

    # Step 1: Create the app
    log_warn "Creating Fly.io app '$name'..."
    local org=$(get_fly_org)
    local app_body="{\"app_name\":\"$name\",\"org_slug\":\"$org\"}"
    local app_response=$(fly_api POST "/apps" "$app_body")

    if echo "$app_response" | grep -q '"error"'; then
        # App might already exist, try to continue
        local error_msg=$(echo "$app_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "$app_response")
        if echo "$error_msg" | grep -qi "already exists"; then
            log_warn "App '$name' already exists, reusing it"
        else
            log_error "Failed to create Fly.io app"
            log_error "API Error: $error_msg"
            log_warn "Common issues:"
            log_warn "  - App name already taken by another user"
            log_warn "  - Invalid organization slug"
            log_warn "  - API token lacks permissions"
            return 1
        fi
    else
        log_info "App '$name' created"
    fi

    # Step 2: Create a machine in the app
    log_warn "Creating Fly.io machine (region: $region, size: $vm_size, memory: ${vm_memory}MB)..."

    local machine_body=$(python3 -c "
import json
body = {
    'name': '$name',
    'region': '$region',
    'config': {
        'image': 'ubuntu:24.04',
        'guest': {
            'cpu_kind': 'shared',
            'cpus': 1,
            'memory_mb': $vm_memory
        },
        'init': {
            'exec': ['/bin/sleep', 'inf']
        },
        'auto_destroy': False
    }
}
print(json.dumps(body))
")

    local response=$(fly_api POST "/apps/$name/machines" "$machine_body")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create Fly.io machine"

        local error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Region unavailable (try different FLY_REGION)"
        log_warn "  - Machine limit reached"
        log_warn "Remediation: Check https://fly.io/dashboard"
        return 1
    fi

    # Extract machine ID and state
    FLY_MACHINE_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])")
    export FLY_MACHINE_ID FLY_APP_NAME="$name"

    log_info "Machine created: ID=$FLY_MACHINE_ID, App=$name"

    # Wait for machine to be in started state
    log_warn "Waiting for machine to start..."
    local max_attempts=30
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response=$(fly_api GET "/apps/$name/machines/$FLY_MACHINE_ID")
        local state=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('state','unknown'))")

        if [[ "$state" == "started" ]]; then
            log_info "Machine is running"
            return 0
        fi

        log_warn "Machine state: $state ($attempt/$max_attempts)"
        sleep 3
        ((attempt++))
    done

    log_error "Machine did not start in time"
    return 1
}

# Wait for base tools to be installed (Fly.io uses bare Ubuntu image)
wait_for_cloud_init() {
    log_warn "Installing base tools on Fly.io machine..."
    run_server "apt-get update -y && apt-get install -y curl unzip git zsh python3 pip" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# Run a command on the Fly.io machine via flyctl ssh
run_server() {
    local cmd="$1"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    local fly_cmd="fly"
    command -v fly &>/dev/null || fly_cmd="flyctl"
    "$fly_cmd" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd" --quiet 2>/dev/null
}

# Upload a file to the machine via base64 encoding through exec
upload_file() {
    local local_path="$1"
    local remote_path="$2"
    local content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")
    # SECURITY: Properly escape paths and content to prevent injection
    local escaped_path
    escaped_path=$(printf '%q' "$remote_path")
    local escaped_content
    escaped_content=$(printf '%q' "$content")
    run_server "echo $escaped_content | base64 -d > $escaped_path"
}

# Start an interactive SSH session on the Fly.io machine
interactive_session() {
    local cmd="$1"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    local fly_cmd="fly"
    command -v fly &>/dev/null || fly_cmd="flyctl"
    "$fly_cmd" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd"
}

# Destroy a Fly.io machine and app
destroy_server() {
    local app_name="${1:-$FLY_APP_NAME}"

    log_warn "Destroying Fly.io app and machines for '$app_name'..."

    # List and destroy all machines in the app
    local machines=$(fly_api GET "/apps/$app_name/machines")
    local machine_ids=$(echo "$machines" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    for m in data:
        print(m['id'])
" 2>/dev/null || true)

    for mid in $machine_ids; do
        log_warn "Stopping machine $mid..."
        fly_api POST "/apps/$app_name/machines/$mid/stop" '{}' >/dev/null 2>&1 || true
        sleep 2
        log_warn "Destroying machine $mid..."
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

    # Upload and append to both .bashrc and .zshrc
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
