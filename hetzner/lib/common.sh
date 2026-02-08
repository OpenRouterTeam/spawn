#!/bin/bash
set -eo pipefail
# Common bash functions for Hetzner Cloud spawn scripts

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
# Hetzner Cloud specific functions
# ============================================================

readonly HETZNER_API_BASE="https://api.hetzner.cloud/v1"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for Hetzner API
hetzner_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$HETZNER_API_BASE" "$HCLOUD_TOKEN" "$method" "$endpoint" "$body"
}

# Ensure HCLOUD_TOKEN is available (env var → config file → prompt+save)
ensure_hcloud_token() {
    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${HCLOUD_TOKEN:-}" ]]; then
        log_info "Using Hetzner API token from environment"
        return 0
    fi

    # 2. Check config file
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/hetzner.json"
    if [[ -f "$config_file" ]]; then
        local saved_token 2>/dev/null)
        saved_token=$(python3 -c "import json; print(json.load(open('$config_file')).get('token',''))"
        if [[ -n "$saved_token" ]]; then
            export HCLOUD_TOKEN="$saved_token"
            log_info "Using Hetzner API token from $config_file"
            return 0
        fi
    fi

    # 3. Prompt and save
    echo ""
    log_warn "Hetzner Cloud API Token Required"
    log_warn "Get your token from: https://console.hetzner.cloud/projects → API Tokens"
    echo ""

    local token
    token=$(validated_read "Enter your Hetzner API token: " validate_api_token) || return 1

    # Validate token by making a test API call
    export HCLOUD_TOKEN="$token"
    local response
    response=$(hetzner_api GET "/servers?per_page=1")
    if echo "$response" | grep -q '"error"'; then
        log_error "Authentication failed: Invalid Hetzner API token"

        # Parse error details
        local error_msg print(d.get('error',{}).get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read());
        log_error "API Error: $error_msg"

        log_warn "Remediation steps:"
        log_warn "  1. Verify token at: https://console.hetzner.cloud/projects → API Tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't expired"
        unset HCLOUD_TOKEN
        return 1
    fi

    # Save to config file
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "token": "$token"
}
EOF
    chmod 600 "$config_file"
    log_info "API token saved to $config_file"
}

# Ensure SSH key exists locally and is registered with Hetzner
ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    # Check if already registered
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "$pub_path")
    local existing_keys
    existing_keys=$(hetzner_api GET "/ssh_keys")
    if echo "$existing_keys" | grep -q "$fingerprint"; then
        log_info "SSH key already registered with Hetzner"
        return 0
    fi

    # Register the key
    log_warn "Registering SSH key with Hetzner..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hetzner_api POST "/ssh_keys" "$register_body")

    if echo "$register_response" | grep -q '"error"'; then
        log_error "Failed to register SSH key with Hetzner"

        # Parse error details
        local error_msg print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read());
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi

    log_info "SSH key registered with Hetzner"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "HETZNER_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Create a Hetzner server with cloud-init
create_server() {
    local name="$1"
    local server_type="${HETZNER_SERVER_TYPE:-cx22}"
    local location="${HETZNER_LOCATION:-fsn1}"
    local image="ubuntu-24.04"

    log_warn "Creating Hetzner server '$name' (type: $server_type, location: $location)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    # JSON-escape the cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_json <<< "$userdata")
    userdata_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"

    local body
    body=$(python3 -c "
import json
body = {
    'name': '$name',
    'server_type': '$server_type',
    'location': '$location',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': json.loads($userdata_json),
    'start_after_create': True
}
print(json.dumps(body))
")

    local response
    response=$(hetzner_api POST "/servers" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create Hetzner server"

        # Parse error details
        local error_msg error'))")
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('error',{}).get('message','Unknown
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Server type/location unavailable (try different HETZNER_SERVER_TYPE or HETZNER_LOCATION)"
        log_warn "  - Server limit reached"
        log_warn "  - Invalid cloud-init userdata"
        log_warn "Remediation: Check https://console.hetzner.cloud/"
        return 1
    fi

    # Extract server ID and IP
    HETZNER_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
    HETZNER_SERVER_IP=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['public_net']['ipv4']['ip'])")
    export HETZNER_SERVER_ID HETZNER_SERVER_IP

    log_info "Server created: ID=$HETZNER_SERVER_ID, IP=$HETZNER_SERVER_IP"
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # SSH_OPTS is defined in shared/common.sh
    # shellcheck disable=SC2154
    generic_ssh_wait "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

# Run a command on the server
run_server() {
    local ip="$1"
    local cmd="$2"
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

# Upload a file to the server
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

# Destroy a Hetzner server
destroy_server() {
    local server_id="$1"

    log_warn "Destroying server $server_id..."
    local response
    response=$(hetzner_api DELETE "/servers/$server_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server: $response"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all Hetzner servers
list_servers() {
    local response
    response=$(hetzner_api GET "/servers")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'TYPE':<10}\")
print('-' * 75)
for s in servers:
    name = s['name']
    sid = str(s['id'])
    status = s['status']
    ip = s.get('public_net', {}).get('ipv4', {}).get('ip', 'N/A')
    stype = s['server_type']['name']
    print(f'{name:<25} {sid:<12} {status:<12} {ip:<16} {stype:<10}')
" <<< "$response"
}
