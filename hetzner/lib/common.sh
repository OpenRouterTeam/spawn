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
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
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
# Outputs: "name  vcpus  ram_gb  disk_gb  price" lines
_list_server_types_for_location() {
    local location="$1"
    local response
    response=$(hetzner_api GET "/server_types?per_page=50")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
location = sys.argv[1]
types = []
for t in data.get('server_types', []):
    if t.get('deprecation') is not None:
        continue
    # Check if this type is available in the requested location
    avail = {p['location']: p for p in t.get('prices', [])}
    if location not in avail:
        continue
    price = float(avail[location]['price_hourly']['gross'])
    ram_gb = t['memory']
    types.append((price, t['name'], t['cores'], ram_gb, t['disk'], t['cpu_type']))
types.sort()
for price, name, cores, ram, disk, cpu in types:
    print(f'{name}|{cores} vCPU|{ram:.0f} GB RAM|{disk} GB disk|{cpu}|\$  {price:.4f}/hr')
" "$location"
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

# Ensure jq is installed (required for server type validation)
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

# Validate that a server type is available at a given location.
# Uses /datacenters API for authoritative availability + /server_types for specs.
# If not available, finds the cheapest equivalent (same CPU family, >= specs).
# Returns 0 and prints a valid server type; returns 1 on failure.
_validate_server_type_for_location() {
    local server_type="$1"
    local location="$2"

    _ensure_jq || return 1

    # Get available server type IDs from /datacenters for this location
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

    # Get all server type details
    local types_response
    types_response=$(hetzner_api GET "/server_types?per_page=50")

    # Check if the requested type is directly available
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

    # Type not available at this location — find a compatible alternative
    local wanted_cpu wanted_cores wanted_memory
    wanted_cpu=$(printf '%s' "$types_response" | jq -r \
        --arg name "$server_type" \
        '.server_types[] | select(.name == $name) | .cpu_type')
    wanted_cores=$(printf '%s' "$types_response" | jq -r \
        --arg name "$server_type" \
        '.server_types[] | select(.name == $name) | .cores')
    wanted_memory=$(printf '%s' "$types_response" | jq -r \
        --arg name "$server_type" \
        '.server_types[] | select(.name == $name) | .memory')

    # Build newline-separated list of "price|name" for available types
    # matching same CPU family with >= cores and >= memory, sorted by price
    local candidates
    candidates=$(printf '%s' "$types_response" | jq -r \
        --arg loc "$location" \
        --arg cpu "$wanted_cpu" \
        --argjson cores "$wanted_cores" \
        --argjson mem "$wanted_memory" \
        --argjson ids "$(printf '%s\n' "$available_ids" | jq -Rn '[inputs | tonumber]')" \
        '[.server_types[]
          | select(.deprecation == null)
          | select(.id as $id | $ids | index($id))
          | select(.cpu_type == $cpu and .cores >= $cores and .memory >= $mem)
          | { name, price: (.prices[] | select(.location == $loc) | .price_hourly.gross) }]
         | sort_by(.price | tonumber)
         | .[]
         | "\(.price)|\(.name)"')

    if [[ -n "$candidates" ]]; then
        local replacement
        replacement=$(printf '%s\n' "$candidates" | head -1 | cut -d'|' -f2)
        printf 'FALLBACK:%s:%s:%s:%s\n' "$server_type" "$replacement" "$location" "$wanted_cpu" >&2
        printf '%s' "$replacement"
        return 0
    fi

    # No same-family match — try any type with >= specs
    candidates=$(printf '%s' "$types_response" | jq -r \
        --arg loc "$location" \
        --argjson cores "$wanted_cores" \
        --argjson mem "$wanted_memory" \
        --argjson ids "$(printf '%s\n' "$available_ids" | jq -Rn '[inputs | tonumber]')" \
        '[.server_types[]
          | select(.deprecation == null)
          | select(.id as $id | $ids | index($id))
          | select(.cores >= $cores and .memory >= $mem)
          | { name, price: (.prices[] | select(.location == $loc) | .price_hourly.gross) }]
         | sort_by(.price | tonumber)
         | .[]
         | "\(.price)|\(.name)"')

    if [[ -n "$candidates" ]]; then
        local replacement
        replacement=$(printf '%s\n' "$candidates" | head -1 | cut -d'|' -f2)
        printf 'FALLBACK:%s:%s:%s:any\n' "$server_type" "$replacement" "$location" >&2
        printf '%s' "$replacement"
        return 0
    fi

    printf 'ERROR:no_compatible_type\n' >&2
    return 1
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
    'name': sys.argv[1],
    'server_type': sys.argv[2],
    'location': sys.argv[3],
    'image': sys.argv[4],
    'ssh_keys': json.loads(sys.argv[5]),
    'user_data': userdata,
    'start_after_create': True
}
print(json.dumps(body))
" "$name" "$server_type" "$location" "$image" "$ssh_key_ids"
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

    # Validate server type is available at selected location; auto-fallback if not
    local validated_type stderr_output
    stderr_output=$(mktemp)
    validated_type=$(_validate_server_type_for_location "$server_type" "$location" 2>"$stderr_output") || {
        local err_info
        err_info=$(cat "$stderr_output")
        rm -f "$stderr_output"
        if echo "$err_info" | grep -q "unknown_type"; then
            log_error "Server type '$server_type' does not exist"
        else
            log_error "Server type '$server_type' is not available in '$location' and no compatible alternative was found"
        fi
        log_error "Run without HETZNER_SERVER_TYPE to see available types for this location"
        return 1
    }
    local fallback_info
    fallback_info=$(cat "$stderr_output")
    rm -f "$stderr_output"
    if echo "$fallback_info" | grep -q "^FALLBACK:"; then
        log_warn "'$server_type' is not available in '$location'"
        log_warn "Using compatible alternative: $validated_type"
        server_type="$validated_type"
    fi

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

    log_step "Destroying server $server_id..."
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
