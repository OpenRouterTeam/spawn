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

# Check if SSH key is registered with Latitude.sh
latitude_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(latitude_api GET "/ssh_keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Latitude.sh
latitude_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")

    local body
    body=$(python3 -c "
import json
body = {
    'data': {
        'type': 'ssh_keys',
        'attributes': {
            'name': '$key_name',
            'public_key': json.loads($json_pub_key)
        }
    }
}
print(json.dumps(body))
")

    local response
    response=$(latitude_api POST "/ssh_keys" "$body")

    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        return 0
    fi

    local error_msg
    error_msg=$(echo "$response" | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    errors = d.get('errors', [])
    if isinstance(errors, list) and errors:
        print(errors[0].get('detail', errors[0].get('title', 'Unknown error')))
    else:
        print('Unknown error')
except: print(sys.stdin.read())
" 2>/dev/null || echo "$response")
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
    local server_name
    server_name=$(get_resource_name "LATITUDE_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Create a Latitude.sh server
create_server() {
    local hostname="$1"
    local plan="${LATITUDE_PLAN:-vm.tiny}"
    local site="${LATITUDE_SITE:-DAL2}"
    local os="${LATITUDE_OS:-ubuntu_24_04_x64_lts}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$plan" || { log_error "Invalid LATITUDE_PLAN"; return 1; }
    validate_region_name "$site" || { log_error "Invalid LATITUDE_SITE"; return 1; }
    validate_resource_name "$os" || { log_error "Invalid LATITUDE_OS"; return 1; }

    log_warn "Creating Latitude.sh server '$hostname' (plan: $plan, site: $site)..."

    # Get project ID
    local project_id
    project_id=$(get_latitude_project_id) || return 1

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(latitude_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('data', [])]
print(json.dumps(ids))
" 2>/dev/null || echo "[]")

    local body
    body=$(python3 -c "
import json
body = {
    'data': {
        'type': 'servers',
        'attributes': {
            'hostname': '$hostname',
            'plan': '$plan',
            'site': '$site',
            'operating_system': '$os',
            'project': '$project_id',
            'ssh_keys': $ssh_key_ids
        }
    }
}
print(json.dumps(body))
")

    local response
    response=$(latitude_api POST "/servers" "$body")

    # Check for errors
    if ! echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
        log_error "Failed to create Latitude.sh server"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    errors = d.get('errors', [])
    if isinstance(errors, list) and errors:
        print(errors[0].get('detail', errors[0].get('title', 'Unknown error')))
    else:
        print('Unknown error')
except: print(sys.stdin.read())
" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Plan/site unavailable (try different LATITUDE_PLAN or LATITUDE_SITE)"
        log_error "  - Server limit reached for your account"
        log_error ""
        log_error "Check your account status: https://www.latitude.sh/dashboard"
        return 1
    fi

    # Extract server ID
    LATITUDE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['id'])")
    export LATITUDE_SERVER_ID

    log_info "Server created: ID=$LATITUDE_SERVER_ID"
    log_warn "Waiting for server provisioning (this may take a few minutes for bare metal)..."
}

# Wait for server to become active and get its IP address
wait_for_server_ready() {
    local server_id="$1"
    local max_attempts=${2:-60}
    local attempt=1

    log_warn "Waiting for server $server_id to become active..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local response
        response=$(latitude_api GET "/servers/$server_id")

        local status
        status=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
server = data.get('data', {})
attrs = server.get('attributes', {})
print(attrs.get('status', 'unknown'))
" 2>/dev/null || echo "unknown")

        if [[ "$status" == "on" ]] || [[ "$status" == "active" ]]; then
            # Extract IP address
            LATITUDE_SERVER_IP=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
server = data.get('data', {})
attrs = server.get('attributes', {})
# Check for IP in network attributes
network = attrs.get('network', {})
if isinstance(network, dict):
    ip = network.get('ip', '')
    if ip:
        print(ip)
        sys.exit(0)
# Check for IP in relationships or included data
ips = attrs.get('ip_addresses', [])
if isinstance(ips, list):
    for ip_obj in ips:
        if isinstance(ip_obj, dict):
            addr = ip_obj.get('address', '')
            if addr and ':' not in addr:  # Skip IPv6
                print(addr)
                sys.exit(0)
        elif isinstance(ip_obj, str) and ':' not in ip_obj:
            print(ip_obj)
            sys.exit(0)
# Fallback: try primary_ipv4
primary = attrs.get('primary_ipv4', '')
if primary:
    print(primary)
    sys.exit(0)
sys.exit(1)
" 2>/dev/null)

            if [[ -n "$LATITUDE_SERVER_IP" ]]; then
                export LATITUDE_SERVER_IP
                log_info "Server active: IP=$LATITUDE_SERVER_IP"
                return 0
            fi

            # IP might not be assigned yet, keep waiting
            log_warn "Server active but IP not yet assigned... (attempt $attempt/$max_attempts)"
        else
            log_warn "Server status: $status (attempt $attempt/$max_attempts)"
        fi

        sleep 10
        attempt=$((attempt + 1))
    done

    log_error "Server failed to become active after $max_attempts attempts"
    return 1
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

# Run a command on the server
run_server() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

# Upload a file to the server
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

# Destroy a Latitude.sh server
destroy_server() {
    local server_id="$1"

    log_warn "Destroying server $server_id..."
    local response
    response=$(latitude_api DELETE "/servers/$server_id")

    if echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get('errors') else 1)" 2>/dev/null; then
        log_error "Failed to destroy server: $response"
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
    log_warn "Installing base tools..."
    run_server "$ip" "apt-get update -qq && apt-get install -y -qq curl unzip git zsh > /dev/null 2>&1"
    log_warn "Installing Bun..."
    run_server "$ip" "curl -fsSL https://bun.sh/install | bash"
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${PATH}\"' >> /root/.bashrc"
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${PATH}\"' >> /root/.zshrc"
    log_info "Base tools installed"
}
