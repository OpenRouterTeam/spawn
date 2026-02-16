#!/bin/bash
# Common bash functions for DigitalOcean spawn scripts

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
# DigitalOcean specific functions
# ============================================================

readonly DO_API_BASE="https://api.digitalocean.com/v2"
SPAWN_DASHBOARD_URL="https://cloud.digitalocean.com/droplets"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# Centralized curl wrapper for DigitalOcean API
do_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" "$method" "$endpoint" "$body"
}

test_do_token() {
    local response
    response=$(do_api GET "/account")
    if [[ "$response" == *'"id"'* ]]; then
        log_info "API token validated"
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify token at: https://cloud.digitalocean.com/account/api/tokens"
        log_error "  2. Ensure the token has read/write permissions"
        log_error "  3. Check token hasn't expired or been revoked"
        return 1
    fi
}

# Ensure DO_API_TOKEN is available (env var -> config file -> prompt+save)
ensure_do_token() {
    ensure_api_token_with_provider \
        "DigitalOcean" \
        "DO_API_TOKEN" \
        "$HOME/.config/spawn/digitalocean.json" \
        "https://cloud.digitalocean.com/account/api/tokens" \
        "test_do_token"
}

# Check if SSH key is registered with DigitalOcean
do_check_ssh_key() {
    check_ssh_key_by_fingerprint do_api "/account/keys" "$1"
}

# Register SSH key with DigitalOcean
do_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(do_api POST "/account/keys" "$register_body")

    if [[ "$register_response" == *'"id"'* ]]; then
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered (check: doctl compute ssh-key list)"
        log_error "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_error "  - API token lacks write permissions"
        return 1
    fi
}

# Ensure SSH key exists locally and is registered with DigitalOcean
ensure_ssh_key() {
    ensure_ssh_key_with_provider do_check_ssh_key do_register_ssh_key "DigitalOcean"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "DO_DROPLET_NAME" "Enter droplet name: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Build the JSON request body for DigitalOcean droplet creation
# Usage: echo "$userdata" | _build_droplet_request_body NAME REGION SIZE IMAGE SSH_KEY_IDS
_build_droplet_request_body() {
    local name="$1" region="$2" size="$3" image="$4"
    local ssh_key_ids="$5"
    python3 -c "
import json, sys
userdata = sys.stdin.read()
name, region, size, image, ssh_key_ids = sys.argv[1:6]
body = {
    'name': name,
    'region': region,
    'size': size,
    'image': image,
    'ssh_keys': json.loads(ssh_key_ids),
    'user_data': userdata,
    'backups': False,
    'monitoring': False
}
print(json.dumps(body))
" "$name" "$region" "$size" "$image" "$ssh_key_ids"
}

# Wait for a DigitalOcean droplet to become active and set its IP
# Sets: DO_SERVER_IP (exported)
# Usage: _wait_for_droplet_active DROPLET_ID [MAX_ATTEMPTS]
_wait_for_droplet_active() {
    local droplet_id="$1"
    local max_attempts="${2:-60}"
    generic_wait_for_instance do_api "/droplets/${droplet_id}" \
        "active" "d['droplet']['status']" \
        "next(n['ip_address'] for n in d['droplet']['networks']['v4'] if n['type']=='public')" \
        DO_SERVER_IP "Droplet" "${max_attempts}"
}

# Check DigitalOcean API response for errors and log diagnostics
# Returns 0 if error detected, 1 if no error
_do_check_create_error() {
    local response="$1"

    if [[ "$response" == *'"id"'* ]] && [[ "$response" == *'"droplet"'* ]]; then
        return 1  # No error
    fi

    log_error "Failed to create DigitalOcean droplet"
    log_error "API Error: $(extract_api_error_message "$response" "Unknown error")"
    log_warn "Common issues:"
    log_warn "  - Insufficient account balance or payment method required"
    log_warn "  - Region/size unavailable (try different DO_REGION or DO_DROPLET_SIZE)"
    log_warn "  - Droplet limit reached (check account limits)"
    log_warn "  - Invalid cloud-init userdata"
    log_warn "Check your dashboard: https://cloud.digitalocean.com/droplets"
    return 0
}

# Create a DigitalOcean droplet with cloud-init
create_server() {
    local name="$1"
    local size="${DO_DROPLET_SIZE:-s-2vcpu-2gb}"
    local region="${DO_REGION:-nyc3}"
    local image="ubuntu-24-04-x64"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$size" || { log_error "Invalid DO_DROPLET_SIZE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid DO_REGION"; return 1; }

    log_step "Creating DigitalOcean droplet '$name' (size: $size, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(do_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    # Get cloud-init userdata and build request body (piped via stdin to avoid quoting issues)
    local userdata
    userdata=$(get_cloud_init_userdata)

    local body
    body=$(echo "$userdata" | _build_droplet_request_body "$name" "$region" "$size" "$image" "$ssh_key_ids")

    local response
    response=$(do_api POST "/droplets" "$body")

    if _do_check_create_error "$response"; then
        return 1
    fi

    DO_DROPLET_ID=$(_extract_json_field "$response" "d['droplet']['id']")
    export DO_DROPLET_ID
    log_info "Droplet created: ID=$DO_DROPLET_ID"

    _wait_for_droplet_active "$DO_DROPLET_ID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a DigitalOcean droplet
destroy_server() {
    local droplet_id="$1"

    log_step "Destroying droplet $droplet_id..."
    local response
    response=$(do_api DELETE "/droplets/$droplet_id")

    # DELETE returns 204 No Content on success (empty body)
    log_info "Droplet $droplet_id destroyed"
}

# List all DigitalOcean droplets
list_servers() {
    local response
    response=$(do_api GET "/droplets")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
droplets = data.get('droplets', [])
if not droplets:
    print('No droplets found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'SIZE':<15}\")
print('-' * 80)
for d in droplets:
    name = d['name']
    did = str(d['id'])
    status = d['status']
    ip = 'N/A'
    for net in d.get('networks', {}).get('v4', []):
        if net['type'] == 'public':
            ip = net['ip_address']
            break
    size = d['size_slug']
    print(f'{name:<25} {did:<12} {status:<12} {ip:<16} {size:<15}')
" <<< "$response"
}
