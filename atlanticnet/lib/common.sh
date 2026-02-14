#!/bin/bash
set -eo pipefail
# Common bash functions for Atlantic.Net Cloud spawn scripts

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
# Atlantic.Net Cloud specific functions
# ============================================================

readonly ATLANTICNET_API_BASE="https://cloudapi.atlantic.net"
SPAWN_DASHBOARD_URL="https://cloud.atlantic.net/"
readonly ATLANTICNET_API_VERSION="2010-12-30"

# Generate HMAC-SHA256 signature for Atlantic.Net API
# Args: timestamp rndguid
atlanticnet_sign() {
    local timestamp="$1"
    local rndguid="$2"
    local private_key="${ATLANTICNET_API_PRIVATE_KEY}"

    local string_to_sign="${timestamp}${rndguid}"
    printf '%s' "$string_to_sign" | openssl dgst -sha256 -hmac "$private_key" -binary | (base64 -w 0 2>/dev/null || base64)
}

# Generate random GUID for request deduplication
atlanticnet_generate_guid() {
    python3 -c "import uuid; print(str(uuid.uuid4()))"
}

# URL encode a string
url_encode() {
    python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

# Centralized API wrapper for Atlantic.Net Cloud API
# Args: action [param1 value1 param2 value2 ...]
atlanticnet_api() {
    local action="$1"; shift

    check_python_available || return 1

    local timestamp
    timestamp=$(date +%s)
    local rndguid
    rndguid=$(atlanticnet_generate_guid)
    local signature
    signature=$(atlanticnet_sign "$timestamp" "$rndguid")
    local encoded_signature
    encoded_signature=$(url_encode "$signature")

    # Build query string
    local query="Action=$action"
    query="${query}&Format=json"
    query="${query}&Version=${ATLANTICNET_API_VERSION}"
    query="${query}&ACSAccessKeyId=${ATLANTICNET_API_KEY}"
    query="${query}&Timestamp=${timestamp}"
    query="${query}&Rndguid=${rndguid}"
    query="${query}&Signature=${encoded_signature}"

    # Add optional parameters
    while [[ $# -gt 0 ]]; do
        local param="$1"; shift
        local value="$1"; shift
        local encoded_value
        encoded_value=$(url_encode "$value")
        query="${query}&${param}=${encoded_value}"
    done

    # Make API request
    curl -fsSL "${ATLANTICNET_API_BASE}/?${query}"
}

# Test API credentials
test_atlanticnet_credentials() {
    local response
    response=$(atlanticnet_api describe-plan planname G2.2GB 2>&1) || {
        log_error "Failed to connect to Atlantic.Net API"
        return 1
    }

    if echo "$response" | grep -qi '"error"'; then
        log_error "API Error: Invalid credentials"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your API credentials at: https://cloud.atlantic.net/ → API Info"
        log_error "  2. Ensure both API Key and API Private Key are correct"
        log_error "  3. Check that your API access is enabled"
        return 1
    fi
    return 0
}

# Ensure Atlantic.Net API credentials are available
ensure_atlanticnet_credentials() {
    ensure_multi_credentials "Atlantic.Net" "$HOME/.config/spawn/atlanticnet.json" \
        "https://cloud.atlantic.net/ -> API Info" test_atlanticnet_credentials \
        "ATLANTICNET_API_KEY:api_key:API Access Key ID" \
        "ATLANTICNET_API_PRIVATE_KEY:api_private_key:API Private Key"
}

# Check if SSH key is registered with Atlantic.Net
# Args: fingerprint
atlanticnet_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(atlanticnet_api list-sshkeys)

    if echo "$response" | grep -q "$fingerprint"; then
        return 0
    fi
    return 1
}

# Extract error message from Atlantic.Net API response
# Atlantic.Net nests errors as {"error":{"message":"..."}} or {"message":"..."}
_atlanticnet_extract_error() {
    local response="$1"
    _extract_json_field "$response" \
        "d.get('error',{}).get('message','') or d.get('message','Unknown error')" \
        "Unknown error"
}

# Register SSH key with Atlantic.Net
# Args: key_name pub_path
atlanticnet_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    log_step "Registering SSH key with Atlantic.Net..."
    local response
    response=$(atlanticnet_api add-sshkey ssh_key_name "$key_name" ssh_key "$pub_key")

    if echo "$response" | grep -qi '"error"'; then
        log_error "Failed to register SSH key: $(_atlanticnet_extract_error "$response")"
        log_error ""
        log_error "Possible causes:"
        log_error "  - SSH key name already exists (try a different hostname or delete the existing key)"
        log_error "  - Invalid SSH key format"
        log_error "  - API key lacks SSH key management permissions"
        return 1
    fi

    log_info "SSH key registered"
    return 0
}

# Ensure SSH key exists locally and is registered with Atlantic.Net
ensure_ssh_key() {
    ensure_ssh_key_with_provider atlanticnet_check_ssh_key atlanticnet_register_ssh_key "Atlantic.Net"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "ATLANTICNET_SERVER_NAME" "Enter server name: "
}

# Get plan name from env var or use default
get_plan_name() {
    local default="${1:-G2.2GB}"
    if [[ -n "${ATLANTICNET_PLAN:-}" ]]; then
        echo "$ATLANTICNET_PLAN"
    else
        echo "$default"
    fi
}

# Get image ID from env var or use default
get_image_id() {
    local default="${1:-ubuntu-24.04_64bit}"
    if [[ -n "${ATLANTICNET_IMAGE:-}" ]]; then
        echo "$ATLANTICNET_IMAGE"
    else
        echo "$default"
    fi
}

# Get location from env var or use default
get_location() {
    local default="${1:-USEAST2}"
    if [[ -n "${ATLANTICNET_LOCATION:-}" ]]; then
        echo "$ATLANTICNET_LOCATION"
    else
        echo "$default"
    fi
}

# Check Atlantic.Net API response for errors and log diagnostics
# Returns 0 if error detected, 1 if no error
_atlanticnet_check_create_error() {
    local response="$1"

    if ! echo "$response" | grep -qi '"error"'; then
        return 1
    fi

    log_error "Failed to create Atlantic.Net server: $(_atlanticnet_extract_error "$response")"
    log_error ""
    log_error "Common issues:"
    log_error "  - Insufficient account balance or payment method required"
    log_error "  - Plan unavailable in selected location (try different ATLANTICNET_PLAN or ATLANTICNET_LOCATION)"
    log_error "  - Server limit reached for your account"
    log_error "  - SSH key not found (ensure key is registered with Atlantic.Net)"
    return 0
}

# Parse instance ID and IP from Atlantic.Net run-instance response
# Sets ATLANTICNET_SERVER_ID and ATLANTICNET_SERVER_IP on success
_atlanticnet_parse_instance_response() {
    local response="$1"

    local instance_id
    instance_id=$(_extract_json_field "$response" \
        "d.get('run-instanceresponse',{}).get('instancesSet',{}).get('item',{}).get('instanceid','')")

    local ip_address
    ip_address=$(_extract_json_field "$response" \
        "d.get('run-instanceresponse',{}).get('instancesSet',{}).get('item',{}).get('ip_address','')")

    if [[ -z "$instance_id" || -z "$ip_address" ]]; then
        log_error "Failed to parse server details from API response"
        log_error "The server may have been created but returned unexpected data"
        log_error "Check your Atlantic.Net dashboard: https://cloud.atlantic.net/"
        return 1
    fi

    ATLANTICNET_SERVER_ID="$instance_id"
    ATLANTICNET_SERVER_IP="$ip_address"
    export ATLANTICNET_SERVER_ID ATLANTICNET_SERVER_IP
}

# Create Atlantic.Net Cloud Server
# Args: server_name
create_server() {
    local name="$1"
    local plan_name
    plan_name=$(get_plan_name)
    local image_id
    image_id=$(get_image_id)
    local location
    location=$(get_location)

    log_step "Creating Atlantic.Net Cloud Server '$name'..."
    log_step "  Plan: $plan_name"
    log_step "  Image: $image_id"
    log_step "  Location: $location"

    # Get SSH key name (use the spawn key)
    local ssh_key_name="spawn-$(hostname)-ed25519"

    local response
    response=$(atlanticnet_api run-instance \
        server_name "$name" \
        planname "$plan_name" \
        imageid "$image_id" \
        vm_location "$location" \
        ServerQty 1 \
        key_id "$ssh_key_name")

    if _atlanticnet_check_create_error "$response"; then
        return 1
    fi

    _atlanticnet_parse_instance_response "$response" || return 1

    log_info "Server created: ID=$ATLANTICNET_SERVER_ID, IP=$ATLANTICNET_SERVER_IP"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Delete Atlantic.Net Cloud Server
# Args: instance_id
destroy_server() {
    local instance_id="$1"

    log_step "Destroying server $instance_id..."
    atlanticnet_api terminate-instance instanceid "$instance_id"
    log_info "Server $instance_id destroyed"
}

# Get available plans
get_available_plans() {
    local response
    response=$(atlanticnet_api describe-plan)
    echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
plans = data.get('describe-planresponse', {}).get('plans', {}).get('item', [])
if isinstance(plans, dict):
    plans = [plans]
for plan in plans:
    name = plan.get('planname', '')
    ram = plan.get('ram', '')
    cpu = plan.get('processor', '')
    disk = plan.get('disk_size', '')
    bandwidth = plan.get('bandwidth', '')
    price = plan.get('price', '')
    print(f'{name}|{cpu} CPU|{ram} RAM|{disk} disk|{bandwidth} bandwidth|\${price}/mo')
"
}

# Get available locations
get_available_locations() {
    cat << 'EOF'
USEAST1|Ashburn, VA|USA
USEAST2|Orlando, FL|USA
USCENTRAL1|Dallas, TX|USA
USWEST1|San Francisco, CA|USA
CAEAST1|Toronto, ON|Canada
EOF
}
