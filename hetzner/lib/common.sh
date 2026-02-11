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
        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
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
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(hetzner_api GET "/ssh_keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Hetzner
hetzner_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hetzner_api POST "/ssh_keys" "$register_body")

    if echo "$register_response" | grep -q '"error"'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
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
    local server_name
    server_name=$(get_resource_name "HETZNER_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Fetch available server types for a given location, sorted by price
# Outputs: "name  vcpus  ram_gb  disk_gb  price" lines
_list_server_types_for_location() {
    local location="$1"
    local response
    response=$(hetzner_api GET "/server_types?per_page=50")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
types = []
for t in data.get('server_types', []):
    if t.get('deprecation') is not None:
        continue
    # Check if this type is available in the requested location
    avail = {p['location']: p for p in t.get('prices', [])}
    if '$location' not in avail:
        continue
    price = float(avail['$location']['price_hourly']['gross'])
    ram_gb = t['memory']
    types.append((price, t['name'], t['cores'], ram_gb, t['disk'], t['cpu_type']))
types.sort()
for price, name, cores, ram, disk, cpu in types:
    print(f'{name}|{cores} vCPU|{ram:.0f} GB RAM|{disk} GB disk|{cpu}|\$  {price:.4f}/hr')
"
}

# Fetch available locations
# Outputs: "name|city|country" lines
_list_locations() {
    local response
    response=$(hetzner_api GET "/locations")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for loc in sorted(data.get('locations', []), key=lambda l: l['name']):
    print(f\"{loc['name']}|{loc['city']}|{loc['country']}\")
"
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

# Build JSON body for Hetzner server creation
# Pipes cloud-init userdata via stdin to avoid bash quoting issues
_hetzner_build_create_body() {
    local name="$1" server_type="$2" location="$3" image="$4" ssh_key_ids="$5"

    local userdata
    userdata=$(get_cloud_init_userdata)

    echo "$userdata" | python3 -c "
import json, sys
userdata = sys.stdin.read()
body = {
    'name': '$name',
    'server_type': '$server_type',
    'location': '$location',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': userdata,
    'start_after_create': True
}
print(json.dumps(body))
"
}

# Check Hetzner API response for errors and log diagnostics
# Hetzner success responses contain "error": null in the action,
# so we must check if the top-level error is a real object (not null)
# Returns 0 if error detected, 1 if no error
_hetzner_check_create_error() {
    local response="$1"

    local has_error
    has_error=$(echo "$response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
err = d.get('error')
print('yes' if err and isinstance(err, dict) else 'no')
" 2>/dev/null || echo "unknown")

    if [[ "$has_error" != "no" ]] && ! echo "$response" | grep -q '"server"'; then
        log_error "Failed to create Hetzner server"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('error',{}).get('message','Unknown error'))" 2>/dev/null || echo "$response")
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

# Create a Hetzner server with cloud-init
create_server() {
    local name="$1"

    # Interactive location + server type selection (skipped if env vars are set)
    local location
    location=$(_pick_location)

    local server_type
    server_type=$(_pick_server_type "$location")

    local image="ubuntu-24.04"

    # Validate inputs to prevent injection into Python code
    validate_resource_name "$server_type" || { log_error "Invalid HETZNER_SERVER_TYPE"; return 1; }
    validate_region_name "$location" || { log_error "Invalid HETZNER_LOCATION"; return 1; }

    log_warn "Creating Hetzner server '$name' (type: $server_type, location: $location)..."

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
    HETZNER_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
    HETZNER_SERVER_IP=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['public_net']['ipv4']['ip'])")
    export HETZNER_SERVER_ID HETZNER_SERVER_IP

    log_info "Server created: ID=$HETZNER_SERVER_ID, IP=$HETZNER_SERVER_IP"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Destroy a Hetzner server
destroy_server() {
    local server_id="$1"

    log_warn "Destroying server $server_id..."
    local response
    response=$(hetzner_api DELETE "/servers/$server_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server: $response"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all Hetzner servers
list_servers() {
    local response
    response=$(hetzner_api GET "/servers")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'TYPE':<10}\")
print('-' * 75)
for s in servers:
    name = s['name']
    sid = str(s['id'])
    status = s['status']
    ip = s.get('public_net', {}).get('ipv4', {}).get('ip', 'N/A')
    stype = s['server_type']['name']
    print(f'{name:<25} {sid:<12} {status:<12} {ip:<16} {stype:<10}')
" <<< "$response"
}
