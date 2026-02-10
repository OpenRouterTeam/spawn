#!/bin/bash
# Common bash functions for BinaryLane spawn scripts

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

# Note: Provider-agnostic functions (logging, OAuth, browser, etc) are now in shared/common.sh

# ============================================================
# BinaryLane specific functions
# ============================================================

readonly BINARYLANE_API_BASE="https://api.binarylane.com.au/v2"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

binarylane_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$BINARYLANE_API_BASE" "$BINARYLANE_API_TOKEN" "$method" "$endpoint" "$body"
}

ensure_binarylane_token() {
    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    if [[ -n "${BINARYLANE_API_TOKEN:-}" ]]; then
        log_info "Using BinaryLane API token from environment"
        return 0
    fi
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/binarylane.json"
    if [[ -f "$config_file" ]]; then
        local saved_key
        saved_key=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('api_token',''))" "$config_file" 2>/dev/null)
        if [[ -n "$saved_key" ]]; then
            export BINARYLANE_API_TOKEN="$saved_key"
            log_info "Using BinaryLane API token from $config_file"
            return 0
        fi
    fi
    echo ""
    log_warn "BinaryLane API Token Required"
    log_warn "Get your API token from: https://home.binarylane.com.au/api-info"
    echo ""
    local api_token
    api_token=$(validated_read "Enter your BinaryLane API token: " validate_api_token) || return 1
    export BINARYLANE_API_TOKEN="$api_token"
    local response
    response=$(binarylane_api GET "/account")
    if echo "$response" | grep -q '"account"'; then
        log_info "API token validated"
    else
        log_error "Authentication failed: Invalid BinaryLane API token"

        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"

        log_warn "Remediation steps:"
        log_warn "  1. Verify API token at: https://home.binarylane.com.au/api-info"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't been revoked"
        unset BINARYLANE_API_TOKEN
        return 1
    fi
    mkdir -p "$config_dir"
    printf '{\n  "api_token": %s\n}\n' "$(json_escape "$api_token")" > "$config_file"
    chmod 600 "$config_file"
    log_info "API token saved to $config_file"
}

# Check if SSH key is registered with BinaryLane
binarylane_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(binarylane_api GET "/account/keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with BinaryLane
binarylane_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(binarylane_api POST "/account/keys" "$register_body")

    if echo "$register_response" | grep -q '"ssh_key"'; then
        return 0
    else
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider binarylane_check_ssh_key binarylane_register_ssh_key "BinaryLane"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "BINARYLANE_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

create_server() {
    local name="$1"
    local size="${BINARYLANE_SIZE:-std-1vcpu}"
    local region="${BINARYLANE_REGION:-syd}"
    local image="${BINARYLANE_IMAGE:-ubuntu-24.04}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$size" || { log_error "Invalid BINARYLANE_SIZE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid BINARYLANE_REGION"; return 1; }
    validate_resource_name "$image" || { log_error "Invalid BINARYLANE_IMAGE"; return 1; }

    log_warn "Creating BinaryLane server '$name' (size: $size, region: $region, image: $image)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(binarylane_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    local userdata
    userdata=$(get_cloud_init_userdata)

    # Pass userdata safely via stdin to avoid triple-quote injection
    local json_userdata
    json_userdata=$(json_escape "$userdata")

    local body
    body=$(python3 -c "
import json, sys
userdata = json.loads(sys.stdin.read())
body = {
    'name': '$name',
    'region': '$region',
    'size': '$size',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': userdata,
    'backups': False
}
print(json.dumps(body))
" <<< "$json_userdata")

    local response
    response=$(binarylane_api POST "/servers" "$body")

    if echo "$response" | grep -q '"server"'; then
        BINARYLANE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
        export BINARYLANE_SERVER_ID
        log_info "Server created: ID=$BINARYLANE_SERVER_ID"
    else
        log_error "Failed to create BinaryLane server"

        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Size/region/image unavailable (try different BINARYLANE_SIZE, BINARYLANE_REGION, or BINARYLANE_IMAGE)"
        log_warn "  - Server limit reached"
        log_warn "  - Invalid cloud-init userdata"
        log_warn "Remediation: Check https://home.binarylane.com.au/"
        return 1
    fi

    # Wait for server to get an IP
    log_warn "Waiting for server to become active..."
    local max_attempts=60
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        status_response=$(binarylane_api GET "/servers/$BINARYLANE_SERVER_ID")
        local status
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['status'])")

        if [[ "$status" == "active" ]]; then
            BINARYLANE_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; networks = json.loads(sys.stdin.read())['server']['networks']['v4']; print([n['ip_address'] for n in networks if n['type'] == 'public'][0])")
            export BINARYLANE_SERVER_IP
            log_info "Server active: IP=$BINARYLANE_SERVER_IP"
            return 0
        fi

        log_warn "Server status: $status ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Server did not become active in time"
    return 1
}

verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # SSH_OPTS is defined in shared/common.sh
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}


run_server() {
    local ip="$1"; local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

upload_file() {
    local ip="$1"; local local_path="$2"; local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

interactive_session() {
    local ip="$1"; local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

destroy_server() {
    local server_id="$1"
    log_warn "Destroying server $server_id..."
    binarylane_api DELETE "/servers/$server_id"
    log_info "Server $server_id destroyed"
}

list_servers() {
    local response
    response=$(binarylane_api GET "/servers")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<10} {'STATUS':<12} {'IP':<16} {'SIZE':<15} {'REGION':<10}\")
print('-' * 98)
for s in servers:
    name = s.get('name', 'N/A')
    sid = s['id']
    status = s['status']
    networks = s.get('networks', {}).get('v4', [])
    ip = next((n['ip_address'] for n in networks if n['type'] == 'public'), 'N/A')
    size = s.get('size', {}).get('slug', 'N/A')
    region = s.get('region', {}).get('slug', 'N/A')
    print(f'{name:<25} {sid:<10} {status:<12} {ip:<16} {size:<15} {region:<10}')
" <<< "$response"
}
