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

# Try to load Contabo credentials from config file
# Returns 0 if all 4 credentials loaded, 1 otherwise
_load_contabo_config() {
    local config_file="$1"
    [[ -f "$config_file" ]] || return 1

    local creds
    creds=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get('client_id', ''))
print(d.get('client_secret', ''))
print(d.get('api_user', ''))
print(d.get('api_password', ''))
" "$config_file" 2>/dev/null) || return 1

    local saved_client_id saved_secret saved_user saved_password
    { read -r saved_client_id; read -r saved_secret; read -r saved_user; read -r saved_password; } <<< "${creds}"

    if [[ -n "$saved_client_id" ]] && [[ -n "$saved_secret" ]] && [[ -n "$saved_user" ]] && [[ -n "$saved_password" ]]; then
        export CONTABO_CLIENT_ID="$saved_client_id"
        export CONTABO_CLIENT_SECRET="$saved_secret"
        export CONTABO_API_USER="$saved_user"
        export CONTABO_API_PASSWORD="$saved_password"
        log_info "Using Contabo credentials from $config_file"
        return 0
    fi
    return 1
}

# Prompt for a single Contabo credential if not already set
# Usage: _prompt_contabo_cred VAR_NAME "prompt text"
_prompt_contabo_cred() {
    local var_name="$1"
    local prompt_text="$2"

    if [[ -n "${!var_name:-}" ]]; then
        return 0
    fi

    local value
    value=$(safe_read "$prompt_text") || return 1
    export "${var_name}=${value}"
}

# Save Contabo credentials to config file using json_escape
_save_contabo_config() {
    local config_file="$1"
    mkdir -p "$(dirname "$config_file")"
    printf '{\n  "client_id": %s,\n  "client_secret": %s,\n  "api_user": %s,\n  "api_password": %s\n}\n' \
        "$(json_escape "$CONTABO_CLIENT_ID")" \
        "$(json_escape "$CONTABO_CLIENT_SECRET")" \
        "$(json_escape "$CONTABO_API_USER")" \
        "$(json_escape "$CONTABO_API_PASSWORD")" > "$config_file"
    chmod 600 "$config_file"
    log_info "Credentials saved to $config_file"
}

# Ensure Contabo credentials are available
ensure_contabo_credentials() {
    check_python_available || return 1

    local config_file="$HOME/.config/spawn/contabo.json"

    # Try environment variables first (all 4 must be set)
    if [[ -n "${CONTABO_CLIENT_ID:-}" ]] && [[ -n "${CONTABO_CLIENT_SECRET:-}" ]] && \
       [[ -n "${CONTABO_API_USER:-}" ]] && [[ -n "${CONTABO_API_PASSWORD:-}" ]]; then
        log_info "Using Contabo credentials from environment"
        return 0
    fi

    # Try config file
    if _load_contabo_config "$config_file"; then
        return 0
    fi

    # Prompt for missing credentials
    echo ""
    log_warn "Contabo API Credentials Required"
    log_warn "Get your credentials from: https://my.contabo.com/api/details"
    echo ""

    _prompt_contabo_cred "CONTABO_CLIENT_ID" "Enter Contabo Client ID: " || return 1
    _prompt_contabo_cred "CONTABO_CLIENT_SECRET" "Enter Contabo Client Secret: " || return 1
    _prompt_contabo_cred "CONTABO_API_USER" "Enter Contabo API User (username/email): " || return 1
    _prompt_contabo_cred "CONTABO_API_PASSWORD" "Enter Contabo API Password: " || return 1

    # Test credentials
    log_info "Testing Contabo credentials..."
    if ! test_contabo_credentials; then
        return 1
    fi

    _save_contabo_config "$config_file"
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
"
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

    log_warn "Creating Contabo instance '$name' (product: $product_id, region: $region)..."

    local ssh_secret_ids
    ssh_secret_ids=$(_contabo_get_ssh_secret_ids)

    local body
    body=$(_contabo_build_instance_body "$name" "$product_id" "$region" "$image_id" "$period" "$ssh_secret_ids")

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
