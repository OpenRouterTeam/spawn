#!/bin/bash
# Common bash functions for Linode (Akamai) spawn scripts

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
# Linode (Akamai) specific functions
# ============================================================

readonly LINODE_API_BASE="https://api.linode.com/v4"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

linode_api() {
    local method="$1" endpoint="$2" body="${3:-}"
    generic_cloud_api "$LINODE_API_BASE" "$LINODE_API_TOKEN" "$method" "$endpoint" "$body"
}

# Extract error message from Linode API response (errors: [{reason: ...}])
# Joins all error reasons with '; ' or returns fallback
_linode_extract_error() {
    local response="$1"
    local fallback="${2:-Unknown error}"
    _extract_json_field "$response" \
        "'; '.join(e.get('reason','Unknown') for e in d.get('errors',[])) or '$fallback'" \
        "$fallback"
}

test_linode_token() {
    local response
    response=$(linode_api GET "/profile")
    if echo "$response" | grep -q '"username"'; then
        log_info "API token validated"
        return 0
    else
        log_error "API Error: $(_linode_extract_error "$response" "Unable to parse error")"
        log_error "How to fix:"
        log_warn "  1. Verify token at: https://cloud.linode.com/profile/tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't expired or been revoked"
        return 1
    fi
}

ensure_linode_token() {
    ensure_api_token_with_provider \
        "Linode" \
        "LINODE_API_TOKEN" \
        "$HOME/.config/spawn/linode.json" \
        "https://cloud.linode.com/profile/tokens" \
        "test_linode_token"
}

# Check if SSH key is registered with Linode
linode_check_ssh_key() {
    check_ssh_key_by_fingerprint linode_api "/profile/sshkeys" "$1"
}

# Register SSH key with Linode
linode_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"label\":$json_name,\"ssh_key\":$json_pub_key}"
    local register_response
    register_response=$(linode_api POST "/profile/sshkeys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        log_error "API Error: $(_linode_extract_error "$register_response" "$register_response")"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider linode_check_ssh_key linode_register_ssh_key "Linode"
}

get_server_name() {
    get_validated_server_name "LINODE_SERVER_NAME" "Enter Linode label: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Fetch all authorized SSH public keys from Linode profile
_linode_fetch_ssh_keys() {
    local ssh_keys_response
    ssh_keys_response=$(linode_api GET "/profile/sshkeys")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keys = [k['ssh_key'] for k in data.get('data', [])]
print(json.dumps(keys))
" <<< "$ssh_keys_response"
}

# Build the JSON request body for Linode instance creation
_linode_build_create_payload() {
    local name="$1" region="$2" type="$3" image="$4" authorized_keys="$5"

    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_b64
    userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    local root_pass
    root_pass=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#\$') for _ in range(32)))")

    python3 -c "
import json, sys
name, region, ltype, image, auth_keys, root_pass, userdata_b64 = sys.argv[1:8]
body = {
    'label': name,
    'region': region,
    'type': ltype,
    'image': image,
    'authorized_keys': json.loads(auth_keys),
    'root_pass': root_pass,
    'metadata': {
        'user_data': userdata_b64
    },
    'booted': True
}
print(json.dumps(body))
" "$name" "$region" "$type" "$image" "$authorized_keys" "$root_pass" "$userdata_b64"
}

# Poll Linode API until instance is running, sets LINODE_SERVER_IP
_linode_wait_for_active() {
    local server_id="$1"
    generic_wait_for_instance linode_api "/linode/instances/${server_id}" \
        "running" "d['status']" "d['ipv4'][0]" \
        LINODE_SERVER_IP "Linode" 60
}

# Log error details when Linode instance creation fails
_linode_handle_create_error() {
    local response="$1"
    log_error "Failed to create Linode instance"
    log_error "API Error: $(_linode_extract_error "$response" "$response")"
    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Type/region unavailable (try different LINODE_TYPE or LINODE_REGION)"
    log_warn "  - Instance limit reached"
    log_warn "  - Invalid cloud-init metadata"
    log_warn "Check your dashboard: https://cloud.linode.com/"
}

create_server() {
    local name="$1"
    local type="${LINODE_TYPE:-g6-standard-1}"
    local region="${LINODE_REGION:-us-east}"
    local image="linode/ubuntu24.04"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$type" || { log_error "Invalid LINODE_TYPE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid LINODE_REGION"; return 1; }

    log_step "Creating Linode '$name' (type: $type, region: $region)..."

    local authorized_keys
    authorized_keys=$(_linode_fetch_ssh_keys)

    local body
    body=$(_linode_build_create_payload "$name" "$region" "$type" "$image" "$authorized_keys")

    local response
    response=$(linode_api POST "/linode/instances" "$body")

    if echo "$response" | grep -q '"id"' && ! echo "$response" | grep -q '"errors"'; then
        LINODE_SERVER_ID=$(_extract_json_field "$response" "d['id']")
        export LINODE_SERVER_ID
        log_info "Linode created: ID=$LINODE_SERVER_ID"
    else
        _linode_handle_create_error "$response"
        return 1
    fi

    _linode_wait_for_active "$LINODE_SERVER_ID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_step "Destroying Linode $server_id..."
    linode_api DELETE "/linode/instances/$server_id"
    log_info "Linode $server_id destroyed"
}

list_servers() {
    local response
    response=$(linode_api GET "/linode/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('data', [])
if not instances: print('No Linodes found'); sys.exit(0)
print(f\"{'LABEL':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'TYPE':<15}\")
print('-' * 80)
for i in instances:
    label = i.get('label','N/A'); lid = str(i['id']); status = i['status']
    ip = i['ipv4'][0] if i.get('ipv4') else 'N/A'; ltype = i['type']
    print(f'{label:<25} {lid:<12} {status:<12} {ip:<16} {ltype:<15}')
" <<< "$response"
}
