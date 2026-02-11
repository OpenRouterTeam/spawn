#!/bin/bash
set -eo pipefail
# Common bash functions for Contabo Cloud spawn scripts

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
# Contabo Cloud specific functions
# ============================================================

readonly CONTABO_API_BASE="https://api.contabo.com/v1"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for Contabo API
contabo_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api_custom_auth "$CONTABO_API_BASE" "$method" "$endpoint" "$body" 3 \
        -H "Authorization: Bearer ${CONTABO_API_TOKEN}" \
        -H "x-request-id: spawn-$(date +%s)-$$"
}

test_contabo_token() {
    local response
    response=$(contabo_api GET "/compute/instances")
    if echo "$response" | grep -q '"error"\|"statusCode":[45]'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','') or d.get('error','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Get your API credentials from: https://my.contabo.com/api/details"
        log_error "  2. Click 'New Credentials' if you don't have one"
        log_error "  3. Use the Client ID and Client Secret to get an access token:"
        log_error "     curl -X POST 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token' \\"
        log_error "       -H 'Content-Type: application/x-www-form-urlencoded' \\"
        log_error "       -d 'client_id=YOUR_CLIENT_ID' \\"
        log_error "       -d 'client_secret=YOUR_CLIENT_SECRET' \\"
        log_error "       -d 'grant_type=client_credentials'"
        log_error "  4. Extract the 'access_token' from response and set: export CONTABO_API_TOKEN=..."
        return 1
    fi
    return 0
}

# Ensure CONTABO_API_TOKEN is available (env var → config file → prompt+save)
ensure_contabo_token() {
    ensure_api_token_with_provider \
        "Contabo" \
        "CONTABO_API_TOKEN" \
        "$HOME/.config/spawn/contabo.json" \
        "https://my.contabo.com/api/details" \
        "test_contabo_token"
}

# Check if SSH key is registered with Contabo
contabo_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(contabo_api GET "/compute/secrets")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Contabo
contabo_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"type\":\"ssh\",\"value\":$json_pub_key}"
    local register_response
    register_response=$(contabo_api POST "/compute/secrets" "$register_body")

    if echo "$register_response" | grep -q '"error"\|"statusCode":[45]'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid ed25519 or RSA public key)"
        log_error "  - API token lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with Contabo
ensure_ssh_key() {
    ensure_ssh_key_with_provider contabo_check_ssh_key contabo_register_ssh_key "Contabo"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "CONTABO_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Get product ID for instance creation
get_product_id() {
    local product_id="${CONTABO_PRODUCT_ID:-V92}"

    # Validate product ID format (alphanumeric)
    if ! validate_resource_name "$product_id"; then
        log_error "Invalid CONTABO_PRODUCT_ID: $product_id"
        return 1
    fi

    echo "$product_id"
}

# Get region for instance creation
get_region() {
    local region="${CONTABO_REGION:-EU}"

    # Validate region name
    if ! validate_region_name "$region"; then
        log_error "Invalid CONTABO_REGION: $region"
        return 1
    fi

    echo "$region"
}

# Create a Contabo instance with cloud-init
create_server() {
    local name="$1"
    local product_id
    product_id=$(get_product_id) || return 1
    local region
    region=$(get_region) || return 1
    local image_id="${CONTABO_IMAGE_ID:-ubuntu-24.04}"
    local period="${CONTABO_PERIOD:-1}"

    # Validate env var inputs
    validate_resource_name "$image_id" || { log_error "Invalid CONTABO_IMAGE_ID"; return 1; }

    log_warn "Creating Contabo instance '$name' (product: $product_id, region: $region)..."

    # Get all SSH key IDs from secrets
    local ssh_secrets_response
    ssh_secrets_response=$(contabo_api GET "/compute/secrets")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_secrets_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
secrets = data.get('data', [])
ssh_secrets = [s['secretId'] for s in secrets if s.get('type') == 'ssh']
print(json.dumps(ssh_secrets))
")

    # JSON-escape the cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_json
    userdata_json=$(echo "$userdata" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")

    local body
    body=$(python3 -c "
import json
body = {
    'displayName': '$name',
    'productId': '$product_id',
    'region': '$region',
    'imageId': '$image_id',
    'period': $period,
    'sshKeys': json.loads('$ssh_key_ids'),
    'userData': json.loads($userdata_json)
}
print(json.dumps(body))
")

    local response
    response=$(contabo_api POST "/compute/instances" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"\|"statusCode":[45]'; then
        log_error "Failed to create Contabo instance"

        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Product/region unavailable (try different CONTABO_PRODUCT_ID or CONTABO_REGION)"
        log_error "  - Instance limit reached for your account"
        log_error "  - Invalid cloud-init userdata"
        log_error ""
        log_error "Check your account status: https://my.contabo.com/"
        return 1
    fi

    # Extract instance ID from response
    CONTABO_INSTANCE_ID=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('data', [])
if instances:
    print(instances[0]['instanceId'])
else:
    sys.exit(1)
" 2>/dev/null)

    if [[ -z "$CONTABO_INSTANCE_ID" ]]; then
        log_error "Failed to extract instance ID from API response"
        return 1
    fi

    export CONTABO_INSTANCE_ID
    log_info "Instance created: ID=$CONTABO_INSTANCE_ID"

    # Wait for instance to get an IP address (Contabo instances take time to provision)
    log_warn "Waiting for instance to get IP address (this may take 2-5 minutes)..."
    local max_attempts=60
    local attempt=0
    while [[ $attempt -lt $max_attempts ]]; do
        attempt=$((attempt + 1))
        local instance_info
        instance_info=$(contabo_api GET "/compute/instances/$CONTABO_INSTANCE_ID")

        CONTABO_SERVER_IP=$(echo "$instance_info" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instance = data.get('data', [{}])[0]
ip_config = instance.get('ipConfig', {})
v4_ips = ip_config.get('v4', {}).get('ip', [])
if v4_ips and v4_ips[0]:
    print(v4_ips[0])
" 2>/dev/null)

        if [[ -n "$CONTABO_SERVER_IP" ]]; then
            export CONTABO_SERVER_IP
            log_info "Instance IP: $CONTABO_SERVER_IP"
            return 0
        fi

        sleep 5
    done

    log_error "Timeout waiting for instance to get IP address"
    return 1
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-60}
    # SSH_OPTS is defined in shared/common.sh
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 10
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

# Destroy a Contabo instance
destroy_server() {
    local instance_id="$1"

    log_warn "Destroying instance $instance_id..."
    local response
    response=$(contabo_api DELETE "/compute/instances/$instance_id")

    if echo "$response" | grep -q '"error"\|"statusCode":[45]'; then
        log_error "Failed to destroy instance: $response"
        return 1
    fi

    log_info "Instance $instance_id destroyed"
}

# List all Contabo instances
list_servers() {
    local response
    response=$(contabo_api GET "/compute/instances")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('data', [])
if not instances:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'PRODUCT':<10}\")
print('-' * 75)
for inst in instances:
    name = inst.get('displayName', 'N/A')
    iid = str(inst['instanceId'])
    status = inst.get('status', 'N/A')
    ip_config = inst.get('ipConfig', {})
    v4_ips = ip_config.get('v4', {}).get('ip', [])
    ip = v4_ips[0] if v4_ips else 'N/A'
    product = inst.get('productId', 'N/A')
    print(f'{name:<25} {iid:<12} {status:<12} {ip:<16} {product:<10}')
" <<< "$response"
}
