#!/bin/bash
set -eo pipefail
# Common bash functions for Contabo spawn scripts

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
# Contabo specific functions
# ============================================================

readonly CONTABO_API_BASE="https://api.contabo.com/v1"
readonly CONTABO_AUTH_URL="https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token"

# Get OAuth access token from Contabo
# Requires: CONTABO_CLIENT_ID, CONTABO_CLIENT_SECRET, CONTABO_API_USER, CONTABO_API_PASSWORD
get_contabo_access_token() {
    local response
    response=$(curl -fsSL \
        -d "client_id=${CONTABO_CLIENT_ID}" \
        -d "client_secret=${CONTABO_CLIENT_SECRET}" \
        --data-urlencode "username=${CONTABO_API_USER}" \
        --data-urlencode "password=${CONTABO_API_PASSWORD}" \
        -d "grant_type=password" \
        "${CONTABO_AUTH_URL}" 2>&1) || {
        log_error "Failed to obtain Contabo OAuth token"
        log_error "Response: $response"
        return 1
    }

    if echo "$response" | grep -q '"error"'; then
        log_error "OAuth authentication failed: $response"
        return 1
    fi

    local token
    token=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('access_token',''))" 2>/dev/null)

    if [[ -z "$token" ]]; then
        log_error "Failed to extract access token from response"
        return 1
    fi

    echo "$token"
}

# Centralized curl wrapper for Contabo API
contabo_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    # Get or refresh access token
    if [[ -z "${CONTABO_ACCESS_TOKEN:-}" ]]; then
        CONTABO_ACCESS_TOKEN=$(get_contabo_access_token) || return 1
        export CONTABO_ACCESS_TOKEN
    fi

    local url="${CONTABO_API_BASE}${endpoint}"
    local response

    if [[ "$method" == "GET" ]]; then
        response=$(curl -fsSL -X GET \
            -H "Authorization: Bearer ${CONTABO_ACCESS_TOKEN}" \
            -H "Content-Type: application/json" \
            "$url" 2>&1) || {
            log_error "GET request failed: $response"
            return 1
        }
    elif [[ "$method" == "POST" ]]; then
        response=$(curl -fsSL -X POST \
            -H "Authorization: Bearer ${CONTABO_ACCESS_TOKEN}" \
            -H "Content-Type: application/json" \
            -H "x-request-id: spawn-$(date +%s)" \
            -d "$body" \
            "$url" 2>&1) || {
            log_error "POST request failed: $response"
            return 1
        }
    elif [[ "$method" == "DELETE" ]]; then
        response=$(curl -fsSL -X DELETE \
            -H "Authorization: Bearer ${CONTABO_ACCESS_TOKEN}" \
            -H "Content-Type: application/json" \
            "$url" 2>&1) || {
            log_error "DELETE request failed: $response"
            return 1
        }
    else
        log_error "Unsupported HTTP method: $method"
        return 1
    fi

    echo "$response"
}

# Test Contabo credentials
test_contabo_credentials() {
    local response
    response=$(contabo_api GET "/compute/instances?page=1&size=1")
    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Get credentials from: https://my.contabo.com/api/details"
        log_error "  2. Ensure you have all 4 required values:"
        log_error "     - Client ID"
        log_error "     - Client Secret"
        log_error "     - API User (username/email)"
        log_error "     - API Password"
        return 1
    fi
    return 0
}

# Ensure Contabo credentials are available
ensure_contabo_credentials() {
    local config_file="$HOME/.config/spawn/contabo.json"

    # Try to load from config file first
    if [[ -f "$config_file" ]]; then
        CONTABO_CLIENT_ID=$(python3 -c "import json; print(json.load(open('$config_file')).get('client_id',''))" 2>/dev/null)
        CONTABO_CLIENT_SECRET=$(python3 -c "import json; print(json.load(open('$config_file')).get('client_secret',''))" 2>/dev/null)
        CONTABO_API_USER=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_user',''))" 2>/dev/null)
        CONTABO_API_PASSWORD=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_password',''))" 2>/dev/null)
        export CONTABO_CLIENT_ID CONTABO_CLIENT_SECRET CONTABO_API_USER CONTABO_API_PASSWORD
    fi

    # Prompt for missing credentials
    if [[ -z "${CONTABO_CLIENT_ID:-}" ]]; then
        log_info "Get your Contabo API credentials from: https://my.contabo.com/api/details"
        printf "Enter Contabo Client ID: "
        CONTABO_CLIENT_ID=$(safe_read) || return 1
        export CONTABO_CLIENT_ID
    fi

    if [[ -z "${CONTABO_CLIENT_SECRET:-}" ]]; then
        printf "Enter Contabo Client Secret: "
        CONTABO_CLIENT_SECRET=$(safe_read) || return 1
        export CONTABO_CLIENT_SECRET
    fi

    if [[ -z "${CONTABO_API_USER:-}" ]]; then
        printf "Enter Contabo API User (username/email): "
        CONTABO_API_USER=$(safe_read) || return 1
        export CONTABO_API_USER
    fi

    if [[ -z "${CONTABO_API_PASSWORD:-}" ]]; then
        printf "Enter Contabo API Password: "
        CONTABO_API_PASSWORD=$(safe_read) || return 1
        export CONTABO_API_PASSWORD
    fi

    # Test credentials
    log_info "Testing Contabo credentials..."
    if ! test_contabo_credentials; then
        return 1
    fi

    # Save to config file
    mkdir -p "$(dirname "$config_file")"
    python3 -c "
import json
config = {
    'client_id': '$CONTABO_CLIENT_ID',
    'client_secret': '$CONTABO_CLIENT_SECRET',
    'api_user': '$CONTABO_API_USER',
    'api_password': '$CONTABO_API_PASSWORD'
}
with open('$config_file', 'w') as f:
    json.dump(config, f, indent=2)
" && chmod 600 "$config_file"

    log_info "Credentials verified and saved to $config_file"
}

# Check if SSH key is registered with Contabo
contabo_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(contabo_api GET "/compute/secrets")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Contabo as a secret
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

    if echo "$register_response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format"
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

# Create a Contabo instance with cloud-init
create_server() {
    local name="$1"

    # Use env vars or defaults
    local region="${CONTABO_REGION:-EU}"
    local product_id="${CONTABO_PRODUCT_ID:-V45}"  # VPS S SSD (2 vCPU, 8 GB RAM)
    local image_id="${CONTABO_IMAGE_ID:-ubuntu-24.04}"
    local period="${CONTABO_PERIOD:-1}"  # 1 month

    log_warn "Creating Contabo instance '$name' (product: $product_id, region: $region)..."

    # Get all SSH secret IDs
    local ssh_secrets_response
    ssh_secrets_response=$(contabo_api GET "/compute/secrets")
    local ssh_secret_ids
    ssh_secret_ids=$(echo "$ssh_secrets_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
secrets = [s['secretId'] for s in data.get('data', []) if s.get('type') == 'ssh']
print(json.dumps(secrets))
" 2>/dev/null || echo "[]")

    # Get cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)

    # Build request body
    local body
    body=$(echo "$userdata" | python3 -c "
import json, sys
userdata = sys.stdin.read()
body = {
    'displayName': '$name',
    'productId': '$product_id',
    'region': '$region',
    'imageId': '$image_id',
    'period': $period,
    'sshKeys': $ssh_secret_ids,
    'userData': userdata,
    'defaultUser': 'root'
}
print(json.dumps(body))
")

    local response
    response=$(contabo_api POST "/compute/instances" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"' || ! echo "$response" | grep -q '"instanceId"'; then
        log_error "Failed to create Contabo instance"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance"
        log_error "  - Product/region unavailable"
        log_error "  - Account limits reached"
        return 1
    fi

    # Extract instance ID
    CONTABO_INSTANCE_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('data',[{}])[0].get('instanceId',''))")
    export CONTABO_INSTANCE_ID

    log_info "Instance created: ID=$CONTABO_INSTANCE_ID"
    log_info "Waiting for instance to be provisioned..."

    # Wait for instance to be running and get IP
    local max_attempts=60
    local attempt=1
    while [[ $attempt -le $max_attempts ]]; do
        sleep 5
        local instance_info
        instance_info=$(contabo_api GET "/compute/instances/$CONTABO_INSTANCE_ID")

        local status
        status=$(echo "$instance_info" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('data',[{}])[0].get('status',''))")

        if [[ "$status" == "running" ]]; then
            CONTABO_SERVER_IP=$(echo "$instance_info" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read()).get('data',[{}])[0]
ip = data.get('ipConfig', {}).get('v4', {}).get('ip', '')
print(ip)
")
            export CONTABO_SERVER_IP
            log_info "Instance running with IP: $CONTABO_SERVER_IP"
            return 0
        fi

        log_info "Instance status: $status (attempt $attempt/$max_attempts)"
        attempt=$((attempt + 1))
    done

    log_error "Instance failed to reach running state within timeout"
    return 1
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
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

# Destroy a Contabo instance
destroy_server() {
    local instance_id="$1"

    log_warn "Destroying instance $instance_id..."
    local response
    response=$(contabo_api DELETE "/compute/instances/$instance_id")

    if echo "$response" | grep -q '"error"'; then
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
print(f\"{'NAME':<25} {'ID':<15} {'STATUS':<12} {'IP':<16} {'PRODUCT':<10}\")
print('-' * 78)
for inst in instances:
    name = inst.get('displayName', 'N/A')
    iid = str(inst.get('instanceId', 'N/A'))
    status = inst.get('status', 'N/A')
    ip = inst.get('ipConfig', {}).get('v4', {}).get('ip', 'N/A')
    product = inst.get('productId', 'N/A')
    print(f'{name:<25} {iid:<15} {status:<12} {ip:<16} {product:<10}')
" <<< "$response"
}
