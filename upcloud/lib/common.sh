#!/bin/bash
set -eo pipefail
# Common bash functions for UpCloud spawn scripts

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
# UpCloud specific functions
# ============================================================

readonly UPCLOUD_API_BASE="https://api.upcloud.com/1.3"

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

# UpCloud API wrapper using Basic Auth with retry logic
# Usage: upcloud_api METHOD ENDPOINT [BODY] [MAX_RETRIES]
upcloud_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    local max_retries="${4:-3}"
    generic_cloud_api_custom_auth "$UPCLOUD_API_BASE" "$method" "$endpoint" "$body" "$max_retries" \
        -u "${UPCLOUD_USERNAME}:${UPCLOUD_PASSWORD}"
}

test_upcloud_credentials() {
    local response
    response=$(upcloud_api GET "/account")
    if echo "$response" | grep -q '"account"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('error_message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://hub.upcloud.com/people/account"
        log_warn "  2. Ensure your sub-account has API access enabled"
        log_warn "  3. Check username and password are correct"
        return 1
    fi
}

# Try loading UpCloud credentials from config file
# Returns 0 if loaded, 1 otherwise
# Ensure UpCloud credentials are available (env var -> config file -> prompt+save)
ensure_upcloud_credentials() {
    ensure_multi_credentials "UpCloud" "$HOME/.config/spawn/upcloud.json" \
        "https://hub.upcloud.com/people/account" test_upcloud_credentials \
        "UPCLOUD_USERNAME:username:API Username" \
        "UPCLOUD_PASSWORD:password:API Password"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "UPCLOUD_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Find Ubuntu 24.04 template UUID
find_ubuntu_template() {
    local response
    response=$(upcloud_api GET "/storage/template")

    local template_uuid
    template_uuid=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
storages = data.get('storages', {}).get('storage', [])
for s in storages:
    title = s.get('title', '').lower()
    if 'ubuntu' in title and '24.04' in title:
        print(s['uuid'])
        break
else:
    # Fallback to any Ubuntu template
    for s in storages:
        title = s.get('title', '').lower()
        if 'ubuntu' in title:
            print(s['uuid'])
            break
" 2>/dev/null)

    if [[ -z "${template_uuid}" ]]; then
        log_error "Could not find Ubuntu template"
        return 1
    fi

    echo "${template_uuid}"
}

# Wait for UpCloud server to become started and get its public IP
# Sets: UPCLOUD_SERVER_IP
# Usage: _wait_for_upcloud_server_ip SERVER_UUID [MAX_ATTEMPTS]
_wait_for_upcloud_server_ip() {
    local server_uuid="$1"
    local max_attempts=${2:-60}
    generic_wait_for_instance upcloud_api "/server/${server_uuid}" \
        "started" "d['server']['state']" \
        "next((i['address'] for i in d['server'].get('ip_addresses',{}).get('ip_address',[]) if i.get('access')=='public' and i.get('family')=='IPv4'), '')" \
        UPCLOUD_SERVER_IP "Server" "${max_attempts}"
}

# Build JSON request body for UpCloud server creation
# Usage: _build_upcloud_server_body NAME ZONE PLAN TEMPLATE_UUID JSON_SSH_KEY
_build_upcloud_server_body() {
    local name="$1" zone="$2" plan="$3" template_uuid="$4" json_ssh_key="$5"

    python3 -c "
import json, sys
ssh_key = json.loads(sys.stdin.read()).strip()
body = {
    'server': {
        'zone': '$zone',
        'title': '$name',
        'hostname': '$name',
        'plan': '$plan',
        'storage_devices': {
            'storage_device': [
                {
                    'action': 'clone',
                    'storage': '$template_uuid',
                    'title': '$name-os',
                    'size': 25,
                    'tier': 'maxiops'
                }
            ]
        },
        'login_user': {
            'username': 'root',
            'create_password': 'no',
            'ssh_keys': {
                'ssh_key': [ssh_key]
            }
        }
    }
}
print(json.dumps(body))
" <<< "$json_ssh_key"
}

# Parse server UUID from create response, or log error and return 1
# Sets UPCLOUD_SERVER_UUID on success
_upcloud_handle_create_response() {
    local response="$1"

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create UpCloud server"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('error_message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Plan not available in zone (try different UPCLOUD_PLAN or UPCLOUD_ZONE)"
        log_warn "  - Server limit reached"
        log_warn "Remediation: Check https://hub.upcloud.com/"
        return 1
    fi

    UPCLOUD_SERVER_UUID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['uuid'])")
    export UPCLOUD_SERVER_UUID
    log_info "Server created: UUID=$UPCLOUD_SERVER_UUID"
}

# Create an UpCloud server
create_server() {
    local name="$1"
    local plan="${UPCLOUD_PLAN:-1xCPU-2GB}"
    local zone="${UPCLOUD_ZONE:-de-fra1}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$plan" || { log_error "Invalid UPCLOUD_PLAN"; return 1; }
    validate_region_name "$zone" || { log_error "Invalid UPCLOUD_ZONE"; return 1; }

    log_warn "Creating UpCloud server '$name' (plan: $plan, zone: $zone)..."

    # Find Ubuntu template
    local template_uuid
    template_uuid=$(find_ubuntu_template) || return 1
    log_info "Using Ubuntu template: $template_uuid"

    # Read SSH public key
    local key_path="${HOME}/.ssh/id_ed25519.pub"
    if [[ ! -f "${key_path}" ]]; then
        log_error "SSH public key not found at ${key_path}"
        return 1
    fi
    local ssh_pub_key
    ssh_pub_key=$(cat "${key_path}")

    # Build request body - pass SSH key safely via stdin
    local json_ssh_key
    json_ssh_key=$(json_escape "$ssh_pub_key")

    local body
    body=$(_build_upcloud_server_body "$name" "$zone" "$plan" "$template_uuid" "$json_ssh_key")

    local response
    response=$(upcloud_api POST "/server" "$body")

    _upcloud_handle_create_response "$response" || return 1

    _wait_for_upcloud_server_ip "$UPCLOUD_SERVER_UUID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy an UpCloud server
destroy_server() {
    local server_uuid="$1"

    log_warn "Stopping server $server_uuid..."
    upcloud_api POST "/server/$server_uuid/stop" '{"stop_server":{"stop_type":"soft","timeout":"60"}}' >/dev/null 2>&1 || true

    # Wait for server to stop
    local max_attempts=30
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        status_response=$(upcloud_api GET "/server/$server_uuid")
        local status
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['state'])" 2>/dev/null || echo "unknown")
        if [[ "$status" == "stopped" ]]; then
            break
        fi
        sleep 2
        attempt=$((attempt + 1))
    done

    log_warn "Destroying server $server_uuid..."
    local response
    response=$(upcloud_api DELETE "/server/$server_uuid?storages=1")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server: $response"
        return 1
    fi

    log_info "Server $server_uuid destroyed"
}

# List all UpCloud servers
list_servers() {
    local response
    response=$(upcloud_api GET "/server")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', {}).get('server', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'TITLE':<25} {'UUID':<40} {'STATE':<12} {'ZONE':<12}\")
print('-' * 89)
for s in servers:
    title = s.get('title', 'N/A')
    uuid = s.get('uuid', 'N/A')
    state = s.get('state', 'N/A')
    zone = s.get('zone', 'N/A')
    print(f'{title:<25} {uuid:<40} {state:<12} {zone:<12}')
" <<< "$response"
}

# Install base tools on server (cloud-init equivalent for UpCloud)
install_base_tools() {
    local ip="$1"

    log_warn "Installing base tools..."
    run_server "$ip" "apt-get update -qq && apt-get install -y -qq curl unzip git zsh python3 > /dev/null 2>&1"

    log_warn "Installing Bun..."
    run_server "$ip" "curl -fsSL https://bun.sh/install | bash"

    log_warn "Installing Node.js..."
    run_server "$ip" "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1 && apt-get install -y -qq nodejs > /dev/null 2>&1"

    # Configure PATH
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${HOME}/.claude/local/bin:\${PATH}\"' >> /root/.bashrc"
    run_server "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.bun/bin:\${HOME}/.claude/local/bin:\${PATH}\"' >> /root/.zshrc"

    log_info "Base tools installed"
}
