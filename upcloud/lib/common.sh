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

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# UpCloud specific functions
# ============================================================

readonly UPCLOUD_API_BASE="https://api.upcloud.com/1.3"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for UpCloud API (uses HTTP Basic Auth)
upcloud_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    local auth_header="Authorization: Basic ${UPCLOUD_API_CREDENTIALS}"

    if [[ -z "$body" ]]; then
        curl -fsSL -X "$method" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            "${UPCLOUD_API_BASE}${endpoint}"
    else
        curl -fsSL -X "$method" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            -d "$body" \
            "${UPCLOUD_API_BASE}${endpoint}"
    fi
}

test_upcloud_credentials() {
    local response
    response=$(upcloud_api GET "/server" 2>&1) || {
        log_error "API request failed"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://hub.upcloud.com/people/account → API → Subaccounts"
        log_warn "  2. Ensure you're using username:password format"
        log_warn "  3. Make sure the subaccount has API access enabled"
        return 1
    }

    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('error_message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://hub.upcloud.com/people/account"
        log_warn "  2. Ensure API access is enabled for your subaccount"
        log_warn "  3. Check that credentials are Base64 encoded correctly"
        return 1
    fi
    return 0
}

# Ensure UPCLOUD_USERNAME and UPCLOUD_PASSWORD are available and create base64 credentials
ensure_upcloud_credentials() {
    local username="${UPCLOUD_USERNAME:-}"
    local password="${UPCLOUD_PASSWORD:-}"
    local config_file="$HOME/.config/spawn/upcloud.json"

    # Try to load from config file if env vars not set
    if [[ -z "$username" || -z "$password" ]] && [[ -f "$config_file" ]]; then
        log_info "Loading UpCloud credentials from $config_file"
        username=$(python3 -c "import json; print(json.load(open('$config_file')).get('username',''))" 2>/dev/null || echo "")
        password=$(python3 -c "import json; print(json.load(open('$config_file')).get('password',''))" 2>/dev/null || echo "")
    fi

    # If still not available, prompt user
    if [[ -z "$username" || -z "$password" ]]; then
        log_warn "UpCloud API credentials not found"
        log_info "Get your API credentials at: https://hub.upcloud.com/people/account → API"
        log_info "You need to create a subaccount with API access enabled"

        username=$(safe_read "Enter UpCloud API username: ") || return 1
        password=$(safe_read "Enter UpCloud API password: ") || return 1

        # Save to config file
        mkdir -p "$(dirname "$config_file")"
        python3 -c "import json; json.dump({'username': '$username', 'password': '$password'}, open('$config_file', 'w'))"
        chmod 600 "$config_file"
        log_info "Credentials saved to $config_file"
    fi

    # Export as Base64-encoded credentials for HTTP Basic Auth
    export UPCLOUD_API_CREDENTIALS
    UPCLOUD_API_CREDENTIALS=$(printf '%s:%s' "$username" "$password" | base64)
    export UPCLOUD_USERNAME="$username"
    export UPCLOUD_PASSWORD="$password"

    # Test credentials
    if ! test_upcloud_credentials; then
        log_error "Failed to authenticate with UpCloud API"
        return 1
    fi

    log_info "UpCloud API credentials validated"
    return 0
}

# Check if SSH key is registered with UpCloud
upcloud_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(upcloud_api GET "/account" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    keys = data.get('account', {}).get('ssh_keys', {}).get('ssh_key', [])
    # Handle both list and single dict response
    if isinstance(keys, dict):
        keys = [keys]
    for key in keys:
        print(key.get('public_key', ''))
except Exception:
    pass
" 2>/dev/null)
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with UpCloud
upcloud_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    local body
    body=$(python3 -c "
import json
data = {
    'ssh_key': {
        'title': '$key_name',
        'public_key': '''$pub_key'''
    }
}
print(json.dumps(data))
")

    local register_response
    register_response=$(upcloud_api POST "/account/ssh_key" "$body" 2>&1)

    if echo "$register_response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('error_message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format"
        log_warn "  - API credentials lack write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with UpCloud
ensure_ssh_key() {
    ensure_ssh_key_with_provider upcloud_check_ssh_key upcloud_register_ssh_key "UpCloud"
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

# Create an UpCloud server with cloud-init
create_server() {
    local name="$1"
    local plan="${UPCLOUD_PLAN:-1xCPU-2GB}"
    local zone="${UPCLOUD_ZONE:-us-nyc1}"
    local storage_size="${UPCLOUD_STORAGE_SIZE:-50}"

    log_warn "Creating UpCloud server '$name' (plan: $plan, zone: $zone)..."

    # Get SSH public key
    local pub_key
    pub_key=$(cat "$HOME/.ssh/spawn_ed25519.pub")

    # Get cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)

    # Create server payload
    local body
    body=$(python3 -c "
import json
import base64

userdata = '''$userdata'''
userdata_b64 = base64.b64encode(userdata.encode()).decode()

body = {
    'server': {
        'hostname': '$name',
        'zone': '$zone',
        'title': '$name',
        'plan': '$plan',
        'storage_devices': {
            'storage_device': [{
                'action': 'clone',
                'storage': '01000000-0000-4000-8000-000030240200',  # Ubuntu 24.04
                'title': '$name-disk',
                'size': $storage_size,
                'tier': 'maxiops'
            }]
        },
        'login_user': {
            'username': 'root',
            'ssh_keys': {
                'ssh_key': ['$pub_key']
            }
        },
        'user_data': userdata_b64
    }
}
print(json.dumps(body))
")

    local response
    response=$(upcloud_api POST "/server" "$body")

    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('error_message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "Server creation failed: $error_msg"
        return 1
    fi

    local server_uuid
    server_uuid=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['uuid'])")

    log_info "Server created with UUID: $server_uuid"
    echo "$server_uuid"
}

# Wait for server to be running and return its IP address
wait_for_server() {
    local server_uuid="$1"
    local max_wait=180
    local elapsed=0

    log_info "Waiting for server to start..."

    while [[ $elapsed -lt $max_wait ]]; do
        local response
        response=$(upcloud_api GET "/server/$server_uuid")

        local state
        state=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['state'])" 2>/dev/null || echo "unknown")

        if [[ "$state" == "started" ]]; then
            local ip
            ip=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ips = data['server']['ip_addresses']['ip_address']
# Handle both list and single dict response
if isinstance(ips, dict):
    ips = [ips]
for ip_obj in ips:
    if ip_obj.get('family') == 'IPv4' and ip_obj.get('access') == 'public':
        print(ip_obj['address'])
        break
" 2>/dev/null)

            if [[ -n "$ip" ]]; then
                log_info "Server is running at $ip"
                echo "$ip"
                return 0
            fi
        fi

        sleep "${POLL_INTERVAL}"
        elapsed=$((elapsed + POLL_INTERVAL))
    done

    log_error "Server failed to start within ${max_wait}s"
    return 1
}

# Run command on server via SSH
run_on_server() {
    local ip="$1"
    local command="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$command"
}

# Upload file to server via SCP
upload_to_server() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start interactive SSH session
interactive_session() {
    local ip="$1"
    log_info "Starting interactive session..."
    log_info "Press Ctrl+D or type 'exit' to end session"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS -t "root@$ip"
}

# Destroy server
destroy_server() {
    local server_uuid="$1"
    log_warn "Destroying server $server_uuid..."

    # Stop server first
    upcloud_api POST "/server/$server_uuid/stop" '{"stop_server":{"type":"soft","timeout":60}}' >/dev/null 2>&1 || true
    sleep 5

    # Delete server and its storage
    local response
    response=$(upcloud_api DELETE "/server/$server_uuid?storages=1" 2>&1)

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server: $response"
        return 1
    fi

    log_info "Server destroyed"
    return 0
}
