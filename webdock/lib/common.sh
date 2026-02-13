#!/bin/bash
# Common bash functions for Webdock spawn scripts

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
# Webdock specific functions
# ============================================================

readonly WEBDOCK_API_BASE="https://api.webdock.io/v1"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

webdock_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$WEBDOCK_API_BASE" "$WEBDOCK_API_TOKEN" "$method" "$endpoint" "$body"
}

test_webdock_token() {
    local response
    response=$(webdock_api GET "/account")
    if echo "$response" | grep -q '"email"'; then
        log_info "API token validated"
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
        log_error "How to fix:"
        log_warn "  1. Log in to your Webdock account"
        log_warn "  2. Go to Account Area > API & Integrations"
        log_warn "  3. Generate a new API key"
        log_warn "  4. Set WEBDOCK_API_TOKEN environment variable"
        return 1
    fi
}

ensure_webdock_token() {
    ensure_api_token_with_provider \
        "Webdock" \
        "WEBDOCK_API_TOKEN" \
        "$HOME/.config/spawn/webdock.json" \
        "https://my.webdock.io/account" \
        "test_webdock_token"
}

# Check if SSH key is registered with Webdock
webdock_check_ssh_key() {
    check_ssh_key_by_fingerprint webdock_api "/account/publicKeys" "$1"
}

# Register SSH key with Webdock
webdock_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"publicKey\":$json_pub_key}"
    local register_response
    register_response=$(webdock_api POST "/account/publicKeys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider webdock_check_ssh_key webdock_register_ssh_key "Webdock"
}

get_server_name() {
    get_validated_server_name "WEBDOCK_SERVER_NAME" "Enter server name: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Build JSON request body for Webdock server creation
# Usage: _webdock_build_server_body NAME SLUG LOCATION_ID PROFILE_SLUG IMAGE_SLUG PUBLIC_KEY_IDS
_webdock_build_server_body() {
    local name="$1" slug="$2" location_id="$3" profile_slug="$4" image_slug="$5" public_key_ids="$6"
    python3 -c "
import json, sys
name, slug, location_id, profile_slug, image_slug, public_key_ids = sys.argv[1:7]
body = {
    'name': name,
    'slug': slug,
    'locationId': location_id,
    'profileSlug': profile_slug,
    'imageSlug': image_slug,
    'publicKeys': json.loads(public_key_ids) if public_key_ids != '[]' else []
}
print(json.dumps(body))
" "$name" "$slug" "$location_id" "$profile_slug" "$image_slug" "$public_key_ids"
}

# Wait for Webdock server to become active and get its IP
# Sets: WEBDOCK_SERVER_IP
# Usage: _wait_for_webdock_server SERVER_SLUG [MAX_ATTEMPTS]
_wait_for_webdock_server() {
    local server_slug="$1"
    local max_attempts=${2:-60}
    generic_wait_for_instance webdock_api "/servers/${server_slug}" \
        "online" \
        "d['status']" \
        "d['ipv4']" \
        WEBDOCK_SERVER_IP "Server" "${max_attempts}"
}

# Fetch all SSH public key IDs from the Webdock account
# Returns: JSON array of key IDs (e.g., [1, 2, 3]) or "[]" if none
_webdock_get_public_key_ids() {
    local response
    response=$(webdock_api GET "/account/publicKeys")
    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    ids = [k['id'] for k in data if 'id' in k]
else:
    ids = []
print(json.dumps(ids))
" 2>/dev/null || echo "[]"
}

# Validate Webdock server creation inputs
# Usage: _webdock_validate_inputs LOCATION PROFILE IMAGE SLUG
_webdock_validate_inputs() {
    validate_resource_name "$1" || { log_error "Invalid WEBDOCK_LOCATION"; return 1; }
    validate_resource_name "$2" || { log_error "Invalid WEBDOCK_PROFILE"; return 1; }
    validate_resource_name "$3" || { log_error "Invalid WEBDOCK_IMAGE"; return 1; }
    validate_resource_name "$4" || { log_error "Invalid server slug"; return 1; }
}

# Extract server slug from creation response or report failure
# Sets: WEBDOCK_SERVER_SLUG on success
# Usage: _webdock_handle_create_response RESPONSE
_webdock_handle_create_response() {
    local response="$1"
    if echo "$response" | grep -q '"slug"'; then
        WEBDOCK_SERVER_SLUG=$(_extract_json_field "$response" "d['slug']")
        export WEBDOCK_SERVER_SLUG
        log_info "Server created: slug=$WEBDOCK_SERVER_SLUG"
        return 0
    fi
    log_error "Failed to create Webdock server"
    log_error "API Error: $(extract_api_error_message "$response" "$response")"
    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Profile/location unavailable (try different WEBDOCK_PROFILE or WEBDOCK_LOCATION)"
    log_warn "  - Server limit reached"
    log_warn "  - Slug already in use"
    log_warn "Check your dashboard: https://my.webdock.io/"
    return 1
}

create_server() {
    local name="$1"
    local slug="${name}"
    local location_id="${WEBDOCK_LOCATION:-fi}"
    local profile_slug="${WEBDOCK_PROFILE:-webdockmicro}"
    local image_slug="${WEBDOCK_IMAGE:-ubuntu2404}"

    _webdock_validate_inputs "$location_id" "$profile_slug" "$image_slug" "$slug" || return 1

    log_step "Creating Webdock server '$name' (profile: $profile_slug, location: $location_id)..."

    local public_key_ids
    public_key_ids=$(_webdock_get_public_key_ids)

    local body
    body=$(_webdock_build_server_body "$name" "$slug" "$location_id" "$profile_slug" "$image_slug" "$public_key_ids")

    local response
    response=$(webdock_api POST "/servers" "$body")

    _webdock_handle_create_response "$response" || return 1

    _wait_for_webdock_server "$WEBDOCK_SERVER_SLUG"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_slug="$1"
    log_step "Destroying server $server_slug..."
    webdock_api DELETE "/servers/$server_slug"
    log_info "Server $server_slug destroyed"
}

list_servers() {
    local response
    response=$(webdock_api GET "/servers")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data if isinstance(data, list) else []
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'SLUG':<25} {'STATUS':<12} {'IP':<16} {'PROFILE':<20}\")
print('-' * 98)
for s in servers:
    name = s.get('name', 'N/A')
    slug = s['slug']
    status = s.get('status', 'N/A')
    ip = s.get('ipv4', 'N/A')
    profile = s.get('profileSlug', 'N/A')
    print(f'{name:<25} {slug:<25} {status:<12} {ip:<16} {profile:<20}')
" <<< "$response"
}
