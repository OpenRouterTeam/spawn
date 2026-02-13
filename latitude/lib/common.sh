#!/bin/bash
set -eo pipefail
# Common bash functions for Latitude.sh spawn scripts

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

# ============================================================
# Latitude.sh specific functions
# ============================================================

readonly LATITUDE_API_BASE="https://api.latitude.sh"

# Centralized curl wrapper for Latitude.sh API
latitude_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$LATITUDE_API_BASE" "$LATITUDE_API_KEY" "$method" "$endpoint" "$body"
}

# Test Latitude.sh API token validity
test_latitude_token() {
    local response
    response=$(latitude_api GET "/projects")
    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        return 0
    fi
    local error_msg
    error_msg=$(echo "$response" | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    errors = d.get('errors', d.get('error', {}))
    if isinstance(errors, list) and errors:
        print(errors[0].get('detail', errors[0].get('title', 'Unknown error')))
    elif isinstance(errors, dict):
        print(errors.get('detail', errors.get('message', 'Unknown error')))
    else:
        print('Unknown error')
except: print('Unable to parse error')
" 2>/dev/null || echo "Unable to parse error")
    log_error "API Error: $error_msg"
    log_error ""
    log_error "How to fix:"
    log_error "  1. Verify your API key at: https://www.latitude.sh/dashboard → Settings & Billing → API Keys"
    log_error "  2. Ensure the API key has not expired"
    log_error "  3. Check that you have an active project"
    return 1
}

# Ensure LATITUDE_API_KEY is available (env var -> config file -> prompt+save)
ensure_latitude_token() {
    ensure_api_token_with_provider \
        "Latitude.sh" \
        "LATITUDE_API_KEY" \
        "$HOME/.config/spawn/latitude.json" \
        "https://www.latitude.sh/dashboard → Settings & Billing → API Keys" \
        "test_latitude_token"
}

# Get the default project ID from the Latitude.sh account
get_latitude_project_id() {
    if [[ -n "${LATITUDE_PROJECT_ID:-}" ]]; then
        echo "$LATITUDE_PROJECT_ID"
        return 0
    fi

    local response
    response=$(latitude_api GET "/projects")
    local project_id
    project_id=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
projects = data.get('data', [])
if not projects:
    sys.exit(1)
# Use first project
print(projects[0]['id'])
" 2>/dev/null)

    if [[ -z "$project_id" ]]; then
        log_error "No projects found in your Latitude.sh account"
        log_error "Create a project at: https://www.latitude.sh/dashboard"
        return 1
    fi

    LATITUDE_PROJECT_ID="$project_id"
    export LATITUDE_PROJECT_ID
    log_info "Using Latitude.sh project: $project_id"
    echo "$project_id"
}

# Extract first error detail from Latitude.sh JSON:API error response
_latitude_extract_error() {
    python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    errors = d.get('errors', [])
    if isinstance(errors, list) and errors:
        print(errors[0].get('detail', errors[0].get('title', 'Unknown error')))
    else:
        print('Unknown error')
except: print(sys.stdin.read())
" 2>/dev/null || cat
}

# Get all SSH key IDs from Latitude.sh account
_latitude_get_ssh_key_ids() {
    local ssh_keys_response
    ssh_keys_response=$(latitude_api GET "/ssh_keys")
    echo "$ssh_keys_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('data', [])]
print(json.dumps(ids))
" 2>/dev/null || echo "[]"
}

# Build JSON:API request body for Latitude.sh server creation
# $1=hostname $2=plan $3=site $4=os $5=project_id $6=ssh_key_ids_json
_latitude_build_server_body() {
    local hostname="$1" plan="$2" site="$3" os="$4" project_id="$5" ssh_key_ids="$6"
    python3 -c "
import json, sys
body = {
    'data': {
        'type': 'servers',
        'attributes': {
            'hostname': sys.argv[1],
            'plan': sys.argv[2],
            'site': sys.argv[3],
            'operating_system': sys.argv[4],
            'project': sys.argv[5],
            'ssh_keys': json.loads(sys.argv[6])
        }
    }
}
print(json.dumps(body))
" "$hostname" "$plan" "$site" "$os" "$project_id" "$ssh_key_ids"
}

# Check if SSH key is registered with Latitude.sh
latitude_check_ssh_key() {
    check_ssh_key_by_fingerprint latitude_api "/ssh_keys" "$1"
}

# Register SSH key with Latitude.sh
latitude_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    local body
    body=$(echo "$pub_key" | python3 -c "
import json, sys
pub_key = sys.stdin.read().strip()
body = {
    'data': {
        'type': 'ssh_keys',
        'attributes': {
            'name': sys.argv[1],
            'public_key': pub_key
        }
    }
}
print(json.dumps(body))
" "$key_name")

    local response
    response=$(latitude_api POST "/ssh_keys" "$body")

    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        return 0
    fi

    local error_msg
    error_msg=$(echo "$response" | _latitude_extract_error)
    log_error "API Error: $error_msg"
    log_error ""
    log_error "Common causes:"
    log_error "  - SSH key already registered with this name"
    log_error "  - Invalid SSH key format (must be valid ed25519 public key)"
    log_error "  - API key lacks write permissions"
    return 1
}

# Ensure SSH key exists locally and is registered with Latitude.sh
ensure_ssh_key() {
    ensure_ssh_key_with_provider latitude_check_ssh_key latitude_register_ssh_key "Latitude.sh"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "LATITUDE_SERVER_NAME" "Enter server name: "
}

# Validate Latitude.sh server creation inputs
# Usage: _latitude_validate_inputs PLAN SITE OS
_latitude_validate_inputs() {
    validate_resource_name "$1" || { log_error "Invalid LATITUDE_PLAN"; return 1; }
    validate_region_name "$2" || { log_error "Invalid LATITUDE_SITE"; return 1; }
    validate_resource_name "$3" || { log_error "Invalid LATITUDE_OS"; return 1; }
}

# Check server creation response for errors and report failure details
# Usage: _latitude_check_create_error RESPONSE
# Returns 0 if there IS an error (caller should return 1), 1 if response is OK
_latitude_check_create_error() {
    local response="$1"
    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        return 1
    fi
    log_error "Failed to create Latitude.sh server"
    local error_msg
    error_msg=$(echo "$response" | _latitude_extract_error)
    log_error "API Error: $error_msg"
    log_error ""
    log_error "Common issues:"
    log_error "  - Insufficient account balance or payment method required"
    log_error "  - Plan/site unavailable (try different LATITUDE_PLAN or LATITUDE_SITE)"
    log_error "  - Server limit reached for your account"
    log_error ""
    log_error "Check your account status: https://www.latitude.sh/dashboard"
    return 0
}

# Extract server ID from creation response or report failure
# Sets: LATITUDE_SERVER_ID on success
# Usage: _latitude_extract_server_id RESPONSE
_latitude_extract_server_id() {
    local response="$1"
    LATITUDE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['id'])")
    export LATITUDE_SERVER_ID
    log_info "Server created: ID=$LATITUDE_SERVER_ID"
}

# Create a Latitude.sh server
create_server() {
    local hostname="$1"
    local plan="${LATITUDE_PLAN:-vm.tiny}"
    local site="${LATITUDE_SITE:-DAL2}"
    local os="${LATITUDE_OS:-ubuntu_24_04_x64_lts}"

    _latitude_validate_inputs "$plan" "$site" "$os" || return 1

    log_step "Creating Latitude.sh server '$hostname' (plan: $plan, site: $site)..."

    local project_id
    project_id=$(get_latitude_project_id) || return 1

    local ssh_key_ids
    ssh_key_ids=$(_latitude_get_ssh_key_ids)

    local body
    body=$(_latitude_build_server_body "$hostname" "$plan" "$site" "$os" "$project_id" "$ssh_key_ids")

    local response
    response=$(latitude_api POST "/servers" "$body")

    if _latitude_check_create_error "$response"; then
        return 1
    fi

    _latitude_extract_server_id "$response"
    log_step "Waiting for server provisioning (this may take a few minutes for bare metal)..."
}

# Python expression to extract IPv4 from Latitude.sh JSON:API response.
# Checks: network.ip, ip_addresses[] (dict or string, skip IPv6), primary_ipv4.
# Used by generic_wait_for_instance; receives 'd' as the parsed JSON dict.
readonly _LATITUDE_IP_PY="(lambda a: (a.get('network',{}).get('ip','') if isinstance(a.get('network'),dict) else '') or next((o.get('address','') if isinstance(o,dict) else o for o in (a.get('ip_addresses') or []) if ':' not in (o.get('address','') if isinstance(o,dict) else o)),None) or a.get('primary_ipv4',''))(d.get('data',{}).get('attributes',{}))"

# Wait for server to become active and get its IP address
# Delegates to generic_wait_for_instance from shared/common.sh.
# Latitude reports status as "on" when active, so we match on "on".
wait_for_server_ready() {
    local server_id="$1"
    local max_attempts=${2:-60}

    INSTANCE_STATUS_POLL_DELAY=10 generic_wait_for_instance latitude_api \
        "/servers/$server_id" \
        "on" \
        "d.get('data',{}).get('attributes',{}).get('status','unknown')" \
        "${_LATITUDE_IP_PY}" \
        LATITUDE_SERVER_IP "Latitude.sh server" "${max_attempts}"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a Latitude.sh server
destroy_server() {
    local server_id="$1"

    log_step "Destroying server $server_id..."
    local response
    response=$(latitude_api DELETE "/servers/$server_id")

    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get('errors') else 1)" 2>/dev/null; then
        log_error "Failed to destroy server $server_id"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_error ""
        log_error "The server may still be running and incurring charges."
        log_error "Delete it manually at: https://www.latitude.sh/dashboard"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all Latitude.sh servers
list_servers() {
    local response
    response=$(latitude_api GET "/servers")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('data', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'HOSTNAME':<25} {'ID':<15} {'STATUS':<12} {'PLAN':<15} {'SITE':<10}\")
print('-' * 77)
for s in servers:
    attrs = s.get('attributes', {})
    hostname = attrs.get('hostname', 'N/A')
    sid = str(s.get('id', 'N/A'))
    status = attrs.get('status', 'N/A')
    plan = attrs.get('plan', 'N/A')
    site = attrs.get('site', 'N/A')
    print(f'{hostname:<25} {sid:<15} {status:<12} {plan:<15} {site:<10}')
" <<< "$response"
}

# Install basic tools on the server (cloud-init equivalent for Latitude.sh)
install_base_tools() {
    local ip="$1"
    log_step "Installing base tools..."
    run_server "$ip" "apt-get update -qq && apt-get install -y -qq curl unzip git zsh > /dev/null 2>&1"
    log_step "Installing Bun..."
    run_server "$ip" "curl -fsSL https://bun.sh/install | bash"
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${PATH}\"' >> /root/.bashrc"
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${PATH}\"' >> /root/.zshrc"
    log_info "Base tools installed"
}
