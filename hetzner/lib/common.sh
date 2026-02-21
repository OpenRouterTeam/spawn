#!/bin/bash
# Common bash functions for Hetzner Cloud spawn scripts

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

# ============================================================
# Hetzner Cloud specific functions
# ============================================================

readonly HETZNER_API_BASE="https://api.hetzner.cloud/v1"
SPAWN_DASHBOARD_URL="https://console.hetzner.cloud/"

# Centralized curl wrapper for Hetzner API
hetzner_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$HETZNER_API_BASE" "$HCLOUD_TOKEN" "$method" "$endpoint" "$body"
}

# Test that the API token works
test_hcloud_token() {
    local response
    response=$(hetzner_api GET "/servers?per_page=1")
    if echo "$response" | grep -q '"error"'; then
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
        log_error "How to fix:"
        log_warn "  1. Verify your token at: https://console.hetzner.cloud/projects → API Tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check the token hasn't expired"
        return 1
    fi
    return 0
}

# Ensure HCLOUD_TOKEN is available (env var -> config file -> prompt+save)
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
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
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

# Create a Hetzner server with cloud-init
create_server() {
    local name="$1"
    local server_type="${HETZNER_SERVER_TYPE:-cx23}"
    local location="${HETZNER_LOCATION:-nbg1}"
    local image="ubuntu-24.04"

    # Validate inputs
    validate_resource_name "$server_type" || { log_error "Invalid HETZNER_SERVER_TYPE"; return 1; }
    validate_region_name "$location" || { log_error "Invalid HETZNER_LOCATION"; return 1; }

    log_step "Creating Hetzner server '$name' (type: $server_type, location: $location)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    # Build request body
    local userdata
    userdata=$(get_cloud_init_userdata)

    local body
    body=$(jq -n \
        --arg name "$name" \
        --arg server_type "$server_type" \
        --arg location "$location" \
        --arg image "$image" \
        --argjson ssh_keys "$ssh_key_ids" \
        --arg user_data "$userdata" \
        '{name: $name, server_type: $server_type, location: $location,
          image: $image, ssh_keys: $ssh_keys, user_data: $user_data,
          start_after_create: true}')

    local response
    response=$(hetzner_api POST "/servers" "$body")

    # Check for errors — Hetzner success responses contain "error": null in the action,
    # so we check for a real error object AND missing server object
    if ! printf '%s' "$response" | jq -e '.server' &>/dev/null; then
        log_error "Failed to create Hetzner server"
        log_error "API Error: $(extract_api_error_message "$response" "Unknown error")"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Server type/location unavailable (try different HETZNER_SERVER_TYPE or HETZNER_LOCATION)"
        log_warn "  - Server limit reached for your account"
        log_warn "Check your dashboard: https://console.hetzner.cloud/"
        return 1
    fi

    HETZNER_SERVER_ID=$(printf '%s' "$response" | jq -r '.server.id')
    HETZNER_SERVER_IP=$(printf '%s' "$response" | jq -r '.server.public_net.ipv4.ip')
    if [[ -z "$HETZNER_SERVER_ID" || "$HETZNER_SERVER_ID" == "null" ]]; then
        log_error "Failed to extract server ID from API response"
        return 1
    fi
    if [[ -z "$HETZNER_SERVER_IP" || "$HETZNER_SERVER_IP" == "null" ]]; then
        log_error "Failed to extract server IP from API response"
        return 1
    fi
    export HETZNER_SERVER_ID HETZNER_SERVER_IP

    log_info "Server created: ID=$HETZNER_SERVER_ID, IP=$HETZNER_SERVER_IP"
    save_vm_connection "${HETZNER_SERVER_IP}" "root" "${HETZNER_SERVER_ID}" "$name" "hetzner"
}

# SSH operations — delegates to shared helpers
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
        log_warn "The server may still be running and incurring charges."
        log_warn "Delete it manually at: https://console.hetzner.cloud/"
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

cloud_authenticate() { prompt_spawn_name; ensure_jq; ensure_hcloud_token; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${HETZNER_SERVER_IP}"; wait_for_cloud_init "${HETZNER_SERVER_IP}" 60; }
cloud_run() { run_server "${HETZNER_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${HETZNER_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${HETZNER_SERVER_IP}" "$1"; }
cloud_label() { echo "Hetzner server"; }
