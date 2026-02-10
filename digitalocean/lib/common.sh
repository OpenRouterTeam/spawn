#!/bin/bash
# Common bash functions for DigitalOcean spawn scripts

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
# DigitalOcean specific functions
# ============================================================

readonly DO_API_BASE="https://api.digitalocean.com/v2"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# Centralized curl wrapper for DigitalOcean API
do_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" "$method" "$endpoint" "$body"
}

test_do_token() {
    local response
    response=$(do_api GET "/account")
    if echo "$response" | grep -q '"id"'; then
        log_info "API token validated"
        return 0
    else
        # Parse error details if available
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Verify token at: https://cloud.digitalocean.com/account/api/tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't expired or been revoked"
        return 1
    fi
}

# Ensure DO_API_TOKEN is available (env var -> config file -> prompt+save)
ensure_do_token() {
    ensure_api_token_with_provider \
        "DigitalOcean" \
        "DO_API_TOKEN" \
        "$HOME/.config/spawn/digitalocean.json" \
        "https://cloud.digitalocean.com/account/api/tokens" \
        "test_do_token"
}

# Check if SSH key is registered with DigitalOcean
do_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(do_api GET "/account/keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with DigitalOcean
do_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(do_api POST "/account/keys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered (check: doctl compute ssh-key list)"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

# Ensure SSH key exists locally and is registered with DigitalOcean
ensure_ssh_key() {
    ensure_ssh_key_with_provider do_check_ssh_key do_register_ssh_key "DigitalOcean"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "DO_DROPLET_NAME" "Enter droplet name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Build the JSON request body for DigitalOcean droplet creation
# Usage: echo "$userdata" | _build_droplet_request_body NAME REGION SIZE IMAGE SSH_KEY_IDS
_build_droplet_request_body() {
    local name="$1" region="$2" size="$3" image="$4"
    local ssh_key_ids="$5"
    python3 -c "
import json, sys
userdata = sys.stdin.read()
body = {
    'name': '$name',
    'region': '$region',
    'size': '$size',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': userdata,
    'backups': False,
    'monitoring': False
}
print(json.dumps(body))
"
}

# Wait for a DigitalOcean droplet to become active and set its IP
# Sets: DO_SERVER_IP (exported)
# Usage: _wait_for_droplet_active DROPLET_ID [MAX_ATTEMPTS]
_wait_for_droplet_active() {
    local droplet_id="$1"
    local max_attempts="${2:-60}"
    local attempt=1

    log_warn "Waiting for droplet to become active..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        status_response=$(do_api GET "/droplets/$droplet_id")
        local status
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['droplet']['status'])")

        if [[ "$status" == "active" ]]; then
            DO_SERVER_IP=$(echo "$status_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for net in data['droplet']['networks']['v4']:
    if net['type'] == 'public':
        print(net['ip_address'])
        break
")
            export DO_SERVER_IP
            log_info "Droplet active: IP=$DO_SERVER_IP"
            return 0
        fi

        log_warn "Droplet status: $status ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Droplet did not become active in time"
    return 1
}

# Create a DigitalOcean droplet with cloud-init
create_server() {
    local name="$1"
    local size="${DO_DROPLET_SIZE:-s-2vcpu-2gb}"
    local region="${DO_REGION:-nyc3}"
    local image="ubuntu-24-04-x64"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$size" || { log_error "Invalid DO_DROPLET_SIZE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid DO_REGION"; return 1; }

    log_warn "Creating DigitalOcean droplet '$name' (size: $size, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(do_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    # Get cloud-init userdata and build request body (piped via stdin to avoid quoting issues)
    local userdata
    userdata=$(get_cloud_init_userdata)

    local body
    body=$(echo "$userdata" | _build_droplet_request_body "$name" "$region" "$size" "$image" "$ssh_key_ids")

    local response
    response=$(do_api POST "/droplets" "$body")

    # Check for errors
    if echo "$response" | grep -q '"id"' && echo "$response" | grep -q '"droplet"'; then
        DO_DROPLET_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['droplet']['id'])")
        export DO_DROPLET_ID
        log_info "Droplet created: ID=$DO_DROPLET_ID"
    else
        log_error "Failed to create DigitalOcean droplet"

        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Region/size unavailable (try different DO_REGION or DO_DROPLET_SIZE)"
        log_warn "  - Droplet limit reached (check account limits)"
        log_warn "  - Invalid cloud-init userdata"
        log_warn "Remediation: Check https://cloud.digitalocean.com/droplets"
        return 1
    fi

    _wait_for_droplet_active "$DO_DROPLET_ID"
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # SSH_OPTS is defined in shared/common.sh
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

# Destroy a DigitalOcean droplet
destroy_server() {
    local droplet_id="$1"

    log_warn "Destroying droplet $droplet_id..."
    local response
    response=$(do_api DELETE "/droplets/$droplet_id")

    # DELETE returns 204 No Content on success (empty body)
    log_info "Droplet $droplet_id destroyed"
}

# List all DigitalOcean droplets
list_servers() {
    local response
    response=$(do_api GET "/droplets")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
droplets = data.get('droplets', [])
if not droplets:
    print('No droplets found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'SIZE':<15}\")
print('-' * 80)
for d in droplets:
    name = d['name']
    did = str(d['id'])
    status = d['status']
    ip = 'N/A'
    for net in d.get('networks', {}).get('v4', []):
        if net['type'] == 'public':
            ip = net['ip_address']
            break
    size = d['size_slug']
    print(f'{name:<25} {did:<12} {status:<12} {ip:<16} {size:<15}')
" <<< "$response"
}
