#!/bin/bash
# Common bash functions for Genesis Cloud spawn scripts

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
# Genesis Cloud specific functions
# ============================================================

readonly GENESIS_API_BASE="https://api.genesiscloud.com/compute/v1"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

# Centralized curl wrapper for Genesis Cloud API
genesis_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$GENESIS_API_BASE" "$GENESIS_API_KEY" "$method" "$endpoint" "$body"
}

test_genesis_token() {
    local response
    response=$(genesis_api GET "/instances?per_page=1")
    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message', d.get('message','No details available')))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Verify API key at: https://developers.genesiscloud.com/"
        log_warn "  2. Ensure the key has read/write permissions"
        log_warn "  3. Check key hasn't been revoked"
        return 1
    fi
    return 0
}

ensure_genesis_token() {
    ensure_api_token_with_provider \
        "Genesis Cloud" \
        "GENESIS_API_KEY" \
        "$HOME/.config/spawn/genesiscloud.json" \
        "https://developers.genesiscloud.com/ → API Keys" \
        "test_genesis_token"
}

# Check if SSH key is registered with Genesis Cloud
genesis_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(genesis_api GET "/ssh-keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Genesis Cloud
genesis_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"value\":$json_pub_key}"
    local register_response
    register_response=$(genesis_api POST "/ssh-keys" "$register_body")

    if echo "$register_response" | grep -q '"ssh_key"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message', d.get('message','Unknown error')))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider genesis_check_ssh_key genesis_register_ssh_key "Genesis Cloud"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "GENESIS_SERVER_NAME" "Enter instance name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

create_server() {
    local name="$1"
    local instance_type="${GENESIS_INSTANCE_TYPE:-vcpu-4_memory-12g_nvidia-rtx-3080-1}"
    local region="${GENESIS_REGION:-ARC-IS-HAF-1}"
    local image="${GENESIS_IMAGE:-Ubuntu 24.04}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$instance_type" || { log_error "Invalid GENESIS_INSTANCE_TYPE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid GENESIS_REGION"; return 1; }
    # Image names may contain spaces (e.g. "Ubuntu 24.04") but must not contain quotes or shell metacharacters
    if [[ "$image" =~ [\'\"\`\$\;\\] ]]; then log_error "Invalid GENESIS_IMAGE: contains unsafe characters"; return 1; fi

    log_warn "Creating Genesis Cloud instance '$name' (type: $instance_type, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(genesis_api GET "/ssh-keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keys = data.get('ssh_keys', [])
ids = [k['id'] for k in keys]
print(json.dumps(ids))
")

    local userdata
    userdata=$(get_cloud_init_userdata)

    local body
    body=$(echo "$userdata" | python3 -c "
import json, sys
userdata = sys.stdin.read()
body = {
    'name': '$name',
    'type': '$instance_type',
    'region': '$region',
    'image': '$image',
    'ssh_key_ids': $ssh_key_ids,
    'startup_script': userdata
}
print(json.dumps(body))
")

    local response
    response=$(genesis_api POST "/instances" "$body")

    if echo "$response" | grep -q '"instance"'; then
        GENESIS_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['id'])")
        export GENESIS_SERVER_ID
        log_info "Instance created: ID=$GENESIS_SERVER_ID"
    else
        log_error "Failed to create Genesis Cloud instance"

        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message', d.get('message','Unknown error')))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Instance type unavailable in region (try different GENESIS_INSTANCE_TYPE or GENESIS_REGION)"
        log_warn "  - Instance limit reached"
        log_warn "Remediation: Check https://console.genesiscloud.com/"
        return 1
    fi

    # Wait for instance to get an IP and become active
    log_warn "Waiting for instance to become active..."
    local max_attempts=60
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        status_response=$(genesis_api GET "/instances/$GENESIS_SERVER_ID")
        local status
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['status'])")

        if [[ "$status" == "active" ]]; then
            GENESIS_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['public_ip'])")
            export GENESIS_SERVER_IP
            log_info "Instance active: IP=$GENESIS_SERVER_IP"
            return 0
        fi

        log_warn "Instance status: $status ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become active in time"
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
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

destroy_server() {
    local server_id="$1"
    log_warn "Destroying instance $server_id..."
    genesis_api DELETE "/instances/$server_id"
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local response
    response=$(genesis_api GET "/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('instances', [])
if not instances:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'TYPE':<40}\")
print('-' * 133)
for i in instances:
    name = i.get('name', 'N/A')
    iid = i['id']
    status = i['status']
    ip = i.get('public_ip', 'N/A')
    itype = i.get('type', 'N/A')
    print(f'{name:<25} {iid:<40} {status:<12} {ip:<16} {itype:<40}')
" <<< "$response"
}
