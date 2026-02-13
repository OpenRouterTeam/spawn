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
hostkey_api() {
    local endpoint="$1"
    local body="${2:-}"

    if [[ -z "${HOSTKEY_API_KEY:-}" ]]; then
        log_error "HOSTKEY_API_KEY is not set"
        return 1
    fi

    local response
    if [[ -n "$body" ]]; then
        response=$(curl -s "${HOSTKEY_API_BASE}${endpoint}" \
            -H "Authorization: Bearer ${HOSTKEY_API_KEY}" \
            -H "Content-Type: application/json" \
            -d "$body")
    else
        response=$(curl -s "${HOSTKEY_API_BASE}${endpoint}" \
            -H "Authorization: Bearer ${HOSTKEY_API_KEY}")
    fi

    printf '%s' "$response"
}

# Test HOSTKEY API key validity
test_hostkey_token() {
    local response
    # Try to get server list as a simple auth test
    response=$(curl -s "${HOSTKEY_API_BASE}/v1/services" \
        -H "Authorization: Bearer ${HOSTKEY_API_KEY:-}" 2>&1)

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
    response=$(hostkey_api "/ssh_keys")

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
    register_response=$(hostkey_api "/ssh_keys" "$register_body")

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

    _ensure_jq || return 1

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

# Ensure jq is installed (required for JSON parsing)
_ensure_jq() {
    if command -v jq &>/dev/null; then
        return 0
    fi

    log_step "Installing jq..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            brew install jq || { log_error "Failed to install jq via Homebrew"; return 1; }
        else
            log_error "Install jq: brew install jq (or https://jqlang.github.io/jq/download/)"
            return 1
        fi
    elif command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y jq || { log_error "Failed to install jq via apt"; return 1; }
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y jq || { log_error "Failed to install jq via dnf"; return 1; }
    elif command -v apk &>/dev/null; then
        sudo apk add jq || { log_error "Failed to install jq via apk"; return 1; }
    else
        log_error "jq is required but not installed. Install from https://jqlang.github.io/jq/download/"
        return 1
    fi

    if ! command -v jq &>/dev/null; then
        log_error "jq not found in PATH after installation"
        return 1
    fi

    log_info "jq installed"
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

    # Build order request
    local order_body
    order_body=$(jq -n \
        --arg name "$name" \
        --arg location "$location" \
        --arg preset "$preset" \
        '{name: $name, location: $location, preset: $preset, os: "ubuntu-24.04"}')

    local response
    response=$(hostkey_api "/eq/order_instance" "$order_body")

    if echo "$response" | grep -qi "error"; then
        log_error "Failed to create HOSTKEY instance"
        local error_msg
        error_msg=$(echo "$response" | jq -r '.error // .message // "Unknown error"' 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance"
        log_error "  - Instance limit reached"
        log_error "  - Invalid location or preset"
        log_error ""
        log_error "Check your account status: https://hostkey.com/"
        return 1
    fi

    # Extract instance ID and IP
    HOSTKEY_INSTANCE_ID=$(printf '%s' "$response" | jq -r '.id // .instance_id')
    HOSTKEY_INSTANCE_IP=$(printf '%s' "$response" | jq -r '.ip // .ipv4')
    export HOSTKEY_INSTANCE_ID HOSTKEY_INSTANCE_IP

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
    response=$(hostkey_api "/eq/terminate" "{\"id\":\"$instance_id\"}")

    if echo "$response" | grep -qi "error"; then
        log_error "Failed to destroy instance: $response"
        return 1
    fi

    log_info "Instance $instance_id destroyed"
}

# List all HOSTKEY instances
list_servers() {
    local response
    response=$(hostkey_api "/v1/services")

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
