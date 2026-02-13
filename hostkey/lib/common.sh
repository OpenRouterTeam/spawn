#!/bin/bash
set -eo pipefail
# Common bash functions for HOSTKEY spawn scripts

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
# HOSTKEY specific functions
# ============================================================

readonly HOSTKEY_API_BASE="https://invapi.hostkey.com"

# Centralized curl wrapper for HOSTKEY API
# Delegates to generic_cloud_api for retry logic and error handling
# Usage: hostkey_api METHOD ENDPOINT [BODY]
hostkey_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    generic_cloud_api "$HOSTKEY_API_BASE" "$HOSTKEY_API_KEY" "$method" "$endpoint" "$body"
}

# Test HOSTKEY API key validity
test_hostkey_token() {
    local response
    response=$(hostkey_api GET "/v1/services" 2>&1) || true

    if echo "$response" | grep -qi "unauthorized\|invalid\|error"; then
        log_error "API Error: Invalid or expired HOSTKEY API key"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Log in to HOSTKEY at: https://hostkey.com/"
        log_error "  2. Navigate to API settings in your account"
        log_error "  3. Generate a new API key if needed"
        log_error "  4. Set HOSTKEY_API_KEY environment variable"
        return 1
    fi
    return 0
}

# Ensure HOSTKEY_API_KEY is available (env var → config file → prompt+save)
ensure_hostkey_token() {
    ensure_api_token_with_provider \
        "HOSTKEY" \
        "HOSTKEY_API_KEY" \
        "$HOME/.config/spawn/hostkey.json" \
        "https://hostkey.com/documentation/apidocs/api/" \
        "test_hostkey_token"
}

# Check if SSH key is registered with HOSTKEY
hostkey_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(hostkey_api GET "/ssh_keys")

    if echo "$response" | grep -q "$fingerprint"; then
        return 0
    fi
    return 1
}

# Register SSH key with HOSTKEY
hostkey_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")

    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hostkey_api POST "/ssh_keys" "$register_body")

    if echo "$register_response" | grep -qi "error"; then
        log_error "API Error: $(echo "$register_response" | grep -o '"message":"[^"]*"' || echo "$register_response")"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format"
        log_error "  - API key lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with HOSTKEY
ensure_ssh_key() {
    ensure_ssh_key_with_provider hostkey_check_ssh_key hostkey_register_ssh_key "HOSTKEY"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "HOSTKEY_SERVER_NAME" "Enter server name: "
}

# List available HOSTKEY locations
_list_locations() {
    printf '%s\n' "nl|Amsterdam|Netherlands"
    printf '%s\n' "de|Frankfurt|Germany"
    printf '%s\n' "fi|Helsinki|Finland"
    printf '%s\n' "is|Reykjavik|Iceland"
    printf '%s\n' "tr|Istanbul|Turkey"
    printf '%s\n' "us|New York|United States"
}

# Interactive location picker (skipped if HOSTKEY_LOCATION is set)
_pick_location() {
    interactive_pick "HOSTKEY_LOCATION" "nl" "locations" _list_locations
}

# Get available instance presets for a location
_list_instance_presets() {
    local location="$1"

    ensure_jq || return 1

    # Call HOSTKEY presets API
    local response
    response=$(curl -s "${HOSTKEY_API_BASE}/presets.php" -X POST \
        --data "action=list" \
        --data "location=${location}")

    # Parse and format response
    printf '%s' "$response" | jq -r \
        '.[] | "\(.id)|\(.cores) vCPU|\(.ram) GB RAM|\(.storage) GB disk|€\(.price)/mo"' 2>/dev/null || {
        log_error "Failed to fetch instance presets"
        return 1
    }
}

# Interactive instance preset picker
_pick_instance_preset() {
    local location="$1"
    _list_presets_for_location() { _list_instance_presets "$location"; }
    interactive_pick "HOSTKEY_INSTANCE_PRESET" "1" "instance presets" _list_presets_for_location "1"
    unset -f _list_presets_for_location
}

# Build JSON order body for HOSTKEY instance creation
# Usage: _hostkey_build_order_body NAME LOCATION PRESET
_hostkey_build_order_body() {
    local name="$1" location="$2" preset="$3"
    jq -n \
        --arg name "$name" \
        --arg location "$location" \
        --arg preset "$preset" \
        '{name: $name, location: $location, preset: $preset, os: "ubuntu-24.04"}'
}

# Check HOSTKEY API response for errors and log diagnostics
# Returns 0 if error detected, 1 if no error
_hostkey_check_create_error() {
    local response="$1"

    if ! echo "$response" | grep -qi "error"; then
        return 1
    fi

    log_error "Failed to create HOSTKEY instance"
    local error_msg
    error_msg=$(printf '%s' "$response" | jq -r '.error // .message // "Unknown error"' 2>/dev/null || echo "$response")
    log_error "API Error: $error_msg"
    log_error ""
    log_error "Common issues:"
    log_error "  - Insufficient account balance"
    log_error "  - Instance limit reached"
    log_error "  - Invalid location or preset"
    log_error ""
    log_error "Check your account status: https://hostkey.com/"
    return 0
}

# Parse instance ID and IP from HOSTKEY order response
# Sets HOSTKEY_INSTANCE_ID and HOSTKEY_INSTANCE_IP on success
_hostkey_parse_instance_response() {
    local response="$1"
    HOSTKEY_INSTANCE_ID=$(printf '%s' "$response" | jq -r '.id // .instance_id')
    HOSTKEY_INSTANCE_IP=$(printf '%s' "$response" | jq -r '.ip // .ipv4')
    export HOSTKEY_INSTANCE_ID HOSTKEY_INSTANCE_IP
}

# Create a HOSTKEY compute instance
create_server() {
    local name="$1"

    # Interactive location + instance preset selection (skipped if env vars are set)
    local location
    location=$(_pick_location)

    local preset
    preset=$(_pick_instance_preset "$location")

    # Validate inputs
    validate_resource_name "$preset" || { log_error "Invalid HOSTKEY_INSTANCE_PRESET"; return 1; }
    validate_region_name "$location" || { log_error "Invalid HOSTKEY_LOCATION"; return 1; }

    log_step "Creating HOSTKEY instance '$name' (preset: $preset, location: $location)..."

    local order_body
    order_body=$(_hostkey_build_order_body "$name" "$location" "$preset")

    local response
    response=$(hostkey_api POST "/eq/order_instance" "$order_body")

    if _hostkey_check_create_error "$response"; then
        return 1
    fi

    _hostkey_parse_instance_response "$response"

    log_info "Instance created: ID=$HOSTKEY_INSTANCE_ID, IP=$HOSTKEY_INSTANCE_IP"

    # Wait for instance to be ready
    log_step "Waiting for instance to be ready..."
    sleep 10
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a HOSTKEY instance
destroy_server() {
    local instance_id="$1"

    log_step "Destroying instance $instance_id..."
    local response
    response=$(hostkey_api POST "/eq/terminate" "{\"id\":\"$instance_id\"}")

    if echo "$response" | grep -qi "error"; then
        log_error "Failed to destroy instance: $response"
        return 1
    fi

    log_info "Instance $instance_id destroyed"
}

# List all HOSTKEY instances
list_servers() {
    local response
    response=$(hostkey_api GET "/v1/services")

    local count
    count=$(printf '%s' "$response" | jq 'length' 2>/dev/null || echo "0")

    if [[ "$count" -eq 0 ]]; then
        printf 'No instances found\n'
        return 0
    fi

    printf '%-25s %-12s %-12s %-16s\n' "NAME" "ID" "STATUS" "IP"
    printf '%s\n' "-----------------------------------------------------------------"
    printf '%s' "$response" | jq -r \
        '.[] | "\(.name // "N/A")|\(.id // "N/A")|\(.status // "N/A")|\(.ip // "N/A")"' \
        | while IFS='|' read -r name sid status ip; do
            printf '%-25s %-12s %-12s %-16s\n' "$name" "$sid" "$status" "$ip"
        done
}
