#!/bin/bash
set -eo pipefail
# Common bash functions for Hetzner Cloud spawn scripts

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
# Hetzner Cloud specific functions
# ============================================================

readonly HETZNER_API_BASE="https://api.hetzner.cloud/v1"
SPAWN_DASHBOARD_URL="https://console.hetzner.cloud/"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for Hetzner API
hetzner_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$HETZNER_API_BASE" "$HCLOUD_TOKEN" "$method" "$endpoint" "$body"
}

test_hcloud_token() {
    local response
    response=$(hetzner_api GET "/servers?per_page=1")
    if echo "$response" | grep -q '"error"'; then
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your token at: https://console.hetzner.cloud/projects → API Tokens"
        log_error "  2. Ensure the token has read/write permissions"
        log_error "  3. Check the token hasn't expired"
        return 1
    fi
    return 0
}

# Ensure HCLOUD_TOKEN is available (env var → config file → prompt+save)
ensure_hcloud_token() {
    ensure_api_token_with_provider \
        "Hetzner Cloud" \
        "HCLOUD_TOKEN" \
        "$HOME/.config/spawn/hetzner.json" \
        "https://console.hetzner.cloud/projects → API Tokens" \
        "test_hcloud_token"
}

# Check if SSH key is registered with Hetzner
hetzner_check_ssh_key() {
    check_ssh_key_by_fingerprint hetzner_api "/ssh_keys" "$1"
}

# Register SSH key with Hetzner
hetzner_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hetzner_api POST "/ssh_keys" "$register_body")

    if echo "$register_response" | grep -q '"error"'; then
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_error "  - API token lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with Hetzner
ensure_ssh_key() {
    ensure_ssh_key_with_provider hetzner_check_ssh_key hetzner_register_ssh_key "Hetzner"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "HETZNER_SERVER_NAME" "Enter server name: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Fetch available server types for a given location, sorted by price
# Uses /datacenters for authoritative availability, /server_types for specs+pricing
# Outputs: "name|vcpus|ram|disk|cpu_type|price" lines
_list_server_types_for_location() {
    local location="$1"

    ensure_jq || return 1

    local dc_response types_response
    dc_response=$(hetzner_api GET "/datacenters")
    types_response=$(hetzner_api GET "/server_types?per_page=50")

    # Get available type IDs from /datacenters for this location
    local available_ids
    available_ids=$(printf '%s' "$dc_response" | jq -c \
        --arg loc "$location" \
        '[.datacenters[] | select(.location.name == $loc) | .server_types.available[]] | unique')

    # Cross-reference with /server_types for specs and pricing, sorted by price
    printf '%s' "$types_response" | jq -r \
        --arg loc "$location" \
        --argjson ids "$available_ids" \
        '[.server_types[]
          | select(.deprecation == null)
          | select(.id as $id | $ids | index($id))
          | { name, cores, memory, disk, cpu_type,
              price: (.prices[] | select(.location == $loc) | .price_hourly.gross) }]
         | sort_by(.price | tonumber)
         | .[]
         | "\(.name)|\(.cores) vCPU|\(.memory) GB RAM|\(.disk) GB disk|\(.cpu_type)|$  \(.price)/hr"'
}

# Fetch available locations from /datacenters API
# Outputs: "name|city|country" lines
_list_locations() {
    ensure_jq || return 1

    local dc_response
    dc_response=$(hetzner_api GET "/datacenters")

    printf '%s' "$dc_response" | jq -r \
        '[.datacenters[].location | {name, city, country}] | unique_by(.name) | sort_by(.name) | .[] | "\(.name)|\(.city)|\(.country)"'
}

# Interactive location picker (skipped if HETZNER_LOCATION is set)
_pick_location() {
    interactive_pick "HETZNER_LOCATION" "fsn1" "locations" _list_locations
}

# Interactive server type picker (skipped if HETZNER_SERVER_TYPE is set)
_pick_server_type() {
    local location="$1"
    # Wrap the location-specific list function for interactive_pick
    _list_server_types_for_current_location() { _list_server_types_for_location "$location"; }
    interactive_pick "HETZNER_SERVER_TYPE" "cpx11" "server types" _list_server_types_for_current_location "cpx11"
    unset -f _list_server_types_for_current_location
}

# Find cheapest available server type matching spec constraints
# $1=types_response $2=location $3=available_ids_json $4=extra_jq_filter
# Outputs "price|name" lines sorted by price, empty if none match
_hetzner_find_candidates() {
    local types_response="$1" location="$2" ids_json="$3" extra_filter="$4"
    printf '%s' "$types_response" | jq -r \
        --arg loc "$location" \
        --argjson ids "$ids_json" \
        "[.server_types[]
          | select(.deprecation == null)
          | select(.id as \$id | \$ids | index(\$id))
          | ${extra_filter}
          | { name, price: (.prices[] | select(.location == \$loc) | .price_hourly.gross) }]
         | sort_by(.price | tonumber)
         | .[]
         | \"\\(.price)|\\(.name)\""
}

# Get available server type IDs for a location from /datacenters API
# Prints one ID per line; returns 1 if no datacenter found for the location
_hetzner_get_available_ids() {
    local location="$1"
    local dc_response
    dc_response=$(hetzner_api GET "/datacenters")

    local available_ids
    available_ids=$(printf '%s' "$dc_response" | jq -r \
        --arg loc "$location" \
        '[.datacenters[] | select(.location.name == $loc) | .server_types.available[]] | unique | .[]')

    if [[ -z "$available_ids" ]]; then
        printf 'ERROR:no_datacenter_for_location\n' >&2
        return 1
    fi
    printf '%s\n' "$available_ids"
}

# Search for a compatible fallback server type when the requested one is unavailable
# Tries same CPU family first, then any family with >= specs
# Prints the fallback type name on success; emits FALLBACK: info on stderr
_hetzner_find_fallback_type() {
    local server_type="$1" types_response="$2" location="$3" available_ids="$4"

    local wanted_specs
    wanted_specs=$(printf '%s' "$types_response" | jq -r \
        --arg name "$server_type" \
        '.server_types[] | select(.name == $name) | "\(.cpu_type) \(.cores) \(.memory)"')
    local wanted_cpu wanted_cores wanted_memory
    read -r wanted_cpu wanted_cores wanted_memory <<< "$wanted_specs"

    local ids_json
    ids_json=$(printf '%s\n' "$available_ids" | jq -Rn '[inputs | tonumber]')

    local family candidates replacement
    for family in "same" "any"; do
        local filter
        if [[ "$family" == "same" ]]; then
            filter="select(.cpu_type == \"${wanted_cpu}\" and .cores >= ${wanted_cores} and .memory >= ${wanted_memory})"
        else
            filter="select(.cores >= ${wanted_cores} and .memory >= ${wanted_memory})"
        fi

        candidates=$(_hetzner_find_candidates "$types_response" "$location" "$ids_json" "$filter")
        if [[ -n "$candidates" ]]; then
            replacement=$(printf '%s\n' "$candidates" | head -1 | cut -d'|' -f2)
            local label="${wanted_cpu}"
            [[ "$family" == "any" ]] && label="any"
            printf 'FALLBACK:%s:%s:%s:%s\n' "$server_type" "$replacement" "$location" "$label" >&2
            printf '%s' "$replacement"
            return 0
        fi
    done

    printf 'ERROR:no_compatible_type\n' >&2
    return 1
}

# Validate that a server type is available at a given location.
# Uses /datacenters API for authoritative availability + /server_types for specs.
# If not available, finds the cheapest equivalent (same CPU family, >= specs).
# Returns 0 and prints a valid server type; returns 1 on failure.
_validate_server_type_for_location() {
    local server_type="$1"
    local location="$2"

    ensure_jq || return 1

    local available_ids
    available_ids=$(_hetzner_get_available_ids "$location") || return 1

    local types_response
    types_response=$(hetzner_api GET "/server_types?per_page=50")

    # Check if the requested type exists and is directly available
    local wanted_id
    wanted_id=$(printf '%s' "$types_response" | jq -r \
        --arg name "$server_type" \
        '.server_types[] | select(.name == $name and .deprecation == null) | .id')

    if [[ -z "$wanted_id" ]]; then
        printf 'ERROR:unknown_type\n' >&2
        return 1
    fi

    if printf '%s\n' "$available_ids" | grep -qx "$wanted_id"; then
        printf '%s' "$server_type"
        return 0
    fi

    _hetzner_find_fallback_type "$server_type" "$types_response" "$location" "$available_ids"
}

# Build JSON body for Hetzner server creation
_hetzner_build_create_body() {
    local name="$1" server_type="$2" location="$3" image="$4" ssh_key_ids="$5"

    local userdata
    userdata=$(get_cloud_init_userdata)

    jq -n \
        --arg name "$name" \
        --arg server_type "$server_type" \
        --arg location "$location" \
        --arg image "$image" \
        --argjson ssh_keys "$ssh_key_ids" \
        --arg user_data "$userdata" \
        '{name: $name, server_type: $server_type, location: $location,
          image: $image, ssh_keys: $ssh_keys, user_data: $user_data,
          start_after_create: true}'
}

# Check Hetzner API response for errors and log diagnostics
# Hetzner success responses contain "error": null in the action,
# so we must check if the top-level error is a real object (not null)
# Returns 0 if error detected, 1 if no error
_hetzner_check_create_error() {
    local response="$1"

    # Check if .error is a non-null object (not the "error": null in action responses)
    local has_error
    has_error=$(printf '%s' "$response" | jq -r \
        'if (.error != null and (.error | type) == "object") then "yes" else "no" end' 2>/dev/null || echo "unknown")

    if [[ "$has_error" != "no" ]] && ! printf '%s' "$response" | jq -e '.server' &>/dev/null; then
        log_error "Failed to create Hetzner server"
        local error_msg
        error_msg=$(printf '%s' "$response" | jq -r '.error.message // "Unknown error"' 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Server type/location unavailable (try different HETZNER_SERVER_TYPE or HETZNER_LOCATION)"
        log_error "  - Server limit reached for your account"
        log_error "  - Invalid cloud-init userdata"
        log_error ""
        log_error "Check your account status: https://console.hetzner.cloud/"
        return 0
    fi
    return 1
}

# Helper: Log validation error details
_hetzner_log_validation_error() {
    local err_info="$1" server_type="$2" location="$3"
    if echo "$err_info" | grep -q "unknown_type"; then
        log_error "Server type '$server_type' does not exist"
    else
        log_error "Server type '$server_type' is not available in '$location' and no compatible alternative was found"
    fi
    log_error "Run without HETZNER_SERVER_TYPE to see available types for this location"
}

# Helper: Handle fallback type swap logging
_hetzner_log_type_change() {
    local fallback_info="$1" server_type="$2" location="$3" validated_type="$4"
    if echo "$fallback_info" | grep -q "^FALLBACK:"; then
        log_warn "'$server_type' is not available in '$location'"
        log_warn "Using compatible alternative: $validated_type"
    fi
}

# Validate server type at location, handling errors and fallback logging.
# On success, prints the (possibly replaced) server type name.
# On failure, logs user-friendly errors and returns 1.
_hetzner_resolve_server_type() {
    local server_type="$1" location="$2"

    local stderr_output validated_type
    stderr_output=$(mktemp)
    validated_type=$(_validate_server_type_for_location "$server_type" "$location" 2>"$stderr_output") || {
        local err_info
        err_info=$(cat "$stderr_output")
        rm -f "$stderr_output"
        _hetzner_log_validation_error "$err_info" "$server_type" "$location"
        return 1
    }
    local fallback_info
    fallback_info=$(cat "$stderr_output")
    rm -f "$stderr_output"
    _hetzner_log_type_change "$fallback_info" "$server_type" "$location" "$validated_type"
    printf '%s' "$validated_type"
}

# Create a Hetzner server with cloud-init
create_server() {
    local name="$1"

    # Interactive location + server type selection (skipped if env vars are set)
    local location
    location=$(_pick_location)

    local server_type
    server_type=$(_pick_server_type "$location")

    local image="ubuntu-24.04"

    # Validate inputs
    validate_resource_name "$server_type" || { log_error "Invalid HETZNER_SERVER_TYPE"; return 1; }
    validate_region_name "$location" || { log_error "Invalid HETZNER_LOCATION"; return 1; }

    # Validate server type at location; auto-fallback if unavailable
    server_type=$(_hetzner_resolve_server_type "$server_type" "$location") || return 1

    log_step "Creating Hetzner server '$name' (type: $server_type, location: $location)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    local body
    body=$(_hetzner_build_create_body "$name" "$server_type" "$location" "$image" "$ssh_key_ids")

    local response
    response=$(hetzner_api POST "/servers" "$body")

    if _hetzner_check_create_error "$response"; then
        return 1
    fi

    # Extract server ID and IP
    HETZNER_SERVER_ID=$(printf '%s' "$response" | jq -r '.server.id')
    HETZNER_SERVER_IP=$(printf '%s' "$response" | jq -r '.server.public_net.ipv4.ip')
    if [[ -z "$HETZNER_SERVER_ID" || "$HETZNER_SERVER_ID" == "null" ]]; then
        log_error "Failed to extract server ID from API response"
        log_error "Response: $response"
        return 1
    fi
    if [[ -z "$HETZNER_SERVER_IP" || "$HETZNER_SERVER_IP" == "null" ]]; then
        log_error "Failed to extract server IP from API response"
        log_error "Response: $response"
        return 1
    fi
    export HETZNER_SERVER_ID HETZNER_SERVER_IP

    log_info "Server created: ID=$HETZNER_SERVER_ID, IP=$HETZNER_SERVER_IP"

    save_vm_connection "${HETZNER_SERVER_IP}" "root" "${HETZNER_SERVER_ID}" "$name" "hetzner"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a Hetzner server
destroy_server() {
    local server_id="$1"

    log_step "Destroying server $server_id..."
    local response
    response=$(hetzner_api DELETE "/servers/$server_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server $server_id"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_error ""
        log_error "The server may still be running and incurring charges."
        log_error "Delete it manually at: https://console.hetzner.cloud/"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all Hetzner servers
list_servers() {
    local response
    response=$(hetzner_api GET "/servers")

    local count
    count=$(printf '%s' "$response" | jq '.servers | length')

    if [[ "$count" -eq 0 ]]; then
        printf 'No servers found\n'
        return 0
    fi

    printf '%-25s %-12s %-12s %-16s %-10s\n' "NAME" "ID" "STATUS" "IP" "TYPE"
    printf '%s\n' "---------------------------------------------------------------------------"
    printf '%s' "$response" | jq -r \
        '.servers[] | "\(.name)|\(.id)|\(.status)|\(.public_net.ipv4.ip // "N/A")|\(.server_type.name)"' \
        | while IFS='|' read -r name sid status ip stype; do
            printf '%-25s %-12s %-12s %-16s %-10s\n' "$name" "$sid" "$status" "$ip" "$stype"
        done
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_hcloud_token; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${HETZNER_SERVER_IP}"; wait_for_cloud_init "${HETZNER_SERVER_IP}" 60; }
cloud_run() { run_server "${HETZNER_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${HETZNER_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${HETZNER_SERVER_IP}" "$1"; }
cloud_label() { echo "Hetzner server"; }
