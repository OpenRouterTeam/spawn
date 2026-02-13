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
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your credentials at: https://my.contabo.com/api/details"
        log_error "  2. Check that CONTABO_CLIENT_ID, CONTABO_CLIENT_SECRET, CONTABO_API_USER,"
        log_error "     and CONTABO_API_PASSWORD are all set correctly"
        log_error "  3. The API password is separate from your Contabo login password"
        return 1
    }

    if echo "$response" | grep -q '"error"'; then
        log_error "Contabo OAuth authentication failed"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify credentials at: https://my.contabo.com/api/details"
        log_error "  2. Ensure your API user has not been deactivated"
        log_error "  3. Re-run to enter new credentials"
        return 1
    fi

    local token
    token=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('access_token',''))" 2>/dev/null)

    if [[ -z "$token" ]]; then
        log_error "Failed to extract access token from Contabo OAuth response"
        log_error "The API returned an unexpected response format."
        log_error "Try again, or check Contabo's API status page."
        return 1
    fi

    echo "$token"
}

# Centralized curl wrapper for Contabo API
# Delegates to generic_cloud_api for retry logic and error handling
contabo_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    # Get or refresh access token
    if [[ -z "${CONTABO_ACCESS_TOKEN:-}" ]]; then
        CONTABO_ACCESS_TOKEN=$(get_contabo_access_token) || return 1
        export CONTABO_ACCESS_TOKEN
    fi

    generic_cloud_api "$CONTABO_API_BASE" "$CONTABO_ACCESS_TOKEN" "$method" "$endpoint" "$body"
}

# Test Contabo credentials
test_contabo_credentials() {
    local response
    response=$(contabo_api GET "/compute/instances?page=1&size=1")
    if echo "$response" | grep -q '"error"'; then
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
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
    ensure_multi_credentials "Contabo" "$HOME/.config/spawn/contabo.json" \
        "https://my.contabo.com/api/details" test_contabo_credentials \
        "CONTABO_CLIENT_ID:client_id:Client ID" \
        "CONTABO_CLIENT_SECRET:client_secret:Client Secret" \
        "CONTABO_API_USER:api_user:API User (email)" \
        "CONTABO_API_PASSWORD:api_password:API Password"
}

# Check if SSH key is registered with Contabo
contabo_check_ssh_key() {
    check_ssh_key_by_fingerprint contabo_api "/compute/secrets" "$1"
}

# Register SSH key with Contabo as a secret
contabo_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"type\":\"ssh\",\"value\":$json_pub_key}"
    local register_response
    register_response=$(contabo_api POST "/compute/secrets" "$register_body")

    if echo "$register_response" | grep -q '"error"'; then
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"
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
    get_validated_server_name "CONTABO_SERVER_NAME" "Enter server name: "
}

# Get all SSH secret IDs from Contabo
_contabo_get_ssh_secret_ids() {
    local ssh_secrets_response
    ssh_secrets_response=$(contabo_api GET "/compute/secrets")
    echo "$ssh_secrets_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
secrets = [s['secretId'] for s in data.get('data', []) if s.get('type') == 'ssh']
print(json.dumps(secrets))
" 2>/dev/null || echo "[]"
}

# Build Contabo instance creation request body
# $1=name $2=product_id $3=region $4=image_id $5=period $6=ssh_secret_ids
_contabo_build_instance_body() {
    local name="$1" product_id="$2" region="$3" image_id="$4" period="$5" ssh_secret_ids="$6"

    local userdata
    userdata=$(get_cloud_init_userdata)

    echo "$userdata" | python3 -c "
import json, sys
userdata = sys.stdin.read()
name, product_id, region, image_id, period, ssh_secret_ids = sys.argv[1:7]
body = {
    'displayName': name,
    'productId': product_id,
    'region': region,
    'imageId': image_id,
    'period': int(period),
    'sshKeys': json.loads(ssh_secret_ids),
    'userData': userdata,
    'defaultUser': 'root'
}
print(json.dumps(body))
" "$name" "$product_id" "$region" "$image_id" "$period" "$ssh_secret_ids"
}

# Poll Contabo API until instance is running, then extract IP
# Sets CONTABO_SERVER_IP on success
_contabo_wait_for_instance() {
    local instance_id="$1"
    generic_wait_for_instance contabo_api "/compute/instances/${instance_id}" \
        "running" "d.get('data',[{}])[0].get('status','')" \
        "d.get('data',[{}])[0].get('ipConfig',{}).get('v4',{}).get('ip','')" \
        CONTABO_SERVER_IP "Instance" 60
}

# Create a Contabo instance with cloud-init
create_server() {
    local name="$1"

    # Use env vars or defaults
    local region="${CONTABO_REGION:-EU}"
    local product_id="${CONTABO_PRODUCT_ID:-V45}"  # VPS S SSD (2 vCPU, 8 GB RAM)
    local image_id="${CONTABO_IMAGE_ID:-ubuntu-24.04}"
    local period="${CONTABO_PERIOD:-1}"  # 1 month

    # Validate inputs to prevent injection into Python code
    validate_resource_name "$product_id" || { log_error "Invalid CONTABO_PRODUCT_ID"; return 1; }
    validate_region_name "$region" || { log_error "Invalid CONTABO_REGION"; return 1; }
    validate_resource_name "$image_id" || { log_error "Invalid CONTABO_IMAGE_ID"; return 1; }
    if [[ ! "$period" =~ ^[0-9]+$ ]]; then
        log_error "Invalid CONTABO_PERIOD: must be a positive integer"
        return 1
    fi

    log_step "Creating Contabo instance '$name' (product: $product_id, region: $region)..."

    local ssh_secret_ids
    ssh_secret_ids=$(_contabo_get_ssh_secret_ids)

    local body
    body=$(_contabo_build_instance_body "$name" "$product_id" "$region" "$image_id" "$period" "$ssh_secret_ids")

    local response
    response=$(contabo_api POST "/compute/instances" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"' || ! echo "$response" | grep -q '"instanceId"'; then
        log_error "Failed to create Contabo instance"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
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
    log_step "Waiting for instance to be provisioned..."

    _contabo_wait_for_instance "$CONTABO_INSTANCE_ID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a Contabo instance
destroy_server() {
    local instance_id="$1"

    log_step "Destroying instance $instance_id..."
    local response
    response=$(contabo_api DELETE "/compute/instances/$instance_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy instance $instance_id"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_error ""
        log_error "The instance may still be running and incurring charges."
        log_error "Delete it manually at: https://my.contabo.com/"
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
