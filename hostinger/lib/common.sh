#!/bin/bash
set -eo pipefail
# Common bash functions for Hostinger VPS spawn scripts

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
# Hostinger VPS specific functions
# ============================================================

readonly HOSTINGER_API_BASE="https://api.hostinger.com/vps/v1"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for Hostinger API
hostinger_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$HOSTINGER_API_BASE" "$HOSTINGER_API_KEY" "$method" "$endpoint" "$body"
}

test_hostinger_token() {
    local response
    response=$(hostinger_api GET "/virtual-machines")
    if echo "$response" | grep -q '"error"\|"message"'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','') or d.get('error','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Log into hPanel at: https://hpanel.hostinger.com/"
        log_error "  2. Click your Profile icon → Account Information"
        log_error "  3. Navigate to API in the sidebar"
        log_error "  4. Click 'Generate token' or 'New token'"
        log_error "  5. Set token name and expiration, then click Generate"
        log_error "  6. Copy the token and set: export HOSTINGER_API_KEY=..."
        return 1
    fi
    return 0
}

# Ensure HOSTINGER_API_KEY is available (env var → config file → prompt+save)
ensure_hostinger_token() {
    ensure_api_token_with_provider \
        "Hostinger" \
        "HOSTINGER_API_KEY" \
        "$HOME/.config/spawn/hostinger.json" \
        "https://hpanel.hostinger.com/ → Profile → Account Information → API" \
        "test_hostinger_token"
}

# Check if SSH key is registered with Hostinger
hostinger_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(hostinger_api GET "/ssh-keys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Hostinger
hostinger_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hostinger_api POST "/ssh-keys" "$register_body")

    if echo "$register_response" | grep -q '"error"\|"message".*fail'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','') or d.get('error','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid ed25519 or RSA public key)"
        log_error "  - API token lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with Hostinger
ensure_ssh_key() {
    ensure_ssh_key_with_provider hostinger_check_ssh_key hostinger_register_ssh_key "Hostinger"
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "HOSTINGER_SERVER_NAME" "Enter VPS name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Fetch available VPS plans
# Outputs: "id|name|vcpus|ram_gb|disk_gb|price" lines
_list_vps_plans() {
    local response
    response=$(hostinger_api GET "/plans")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
plans = []
for p in data.get('plans', []):
    if p.get('available', True):
        plan_id = p['id']
        name = p.get('name', plan_id)
        vcpus = p.get('vcpus', 'N/A')
        ram = p.get('ram_mb', 0) / 1024.0
        disk = p.get('disk_gb', 'N/A')
        price = float(p.get('price_monthly', 0)) / 730.0  # Monthly to hourly
        plans.append((price, plan_id, name, vcpus, ram, disk))
plans.sort()
for price, pid, name, vcpus, ram, disk in plans:
    print(f'{pid}|{name}|{vcpus} vCPU|{ram:.1f} GB RAM|{disk} GB disk|\${price:.4f}/hr')
"
}

# Fetch available locations
# Outputs: "id|name|country" lines
_list_locations() {
    local response
    response=$(hostinger_api GET "/locations")

    echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for loc in sorted(data.get('locations', []), key=lambda l: l.get('name', '')):
    loc_id = loc['id']
    name = loc.get('name', loc_id)
    country = loc.get('country', 'Unknown')
    print(f\"{loc_id}|{name}|{country}\")
"
}

# Interactive location picker (skipped if HOSTINGER_LOCATION is set)
_pick_location() {
    interactive_pick "HOSTINGER_LOCATION" "eu-central" "locations" _list_locations
}

# Interactive VPS plan picker (skipped if HOSTINGER_PLAN is set)
_pick_plan() {
    interactive_pick "HOSTINGER_PLAN" "kvm1" "VPS plans" _list_vps_plans "kvm1"
}

# Create a Hostinger VPS with cloud-init
create_server() {
    local name="$1"

    # Interactive location + plan selection (skipped if env vars are set)
    local location
    location=$(_pick_location)

    local plan
    plan=$(_pick_plan)

    local os_template="${HOSTINGER_OS_TEMPLATE:-ubuntu-24.04}"

    # Validate inputs to prevent injection into Python code
    validate_resource_name "$plan" || { log_error "Invalid HOSTINGER_PLAN"; return 1; }
    validate_region_name "$location" || { log_error "Invalid HOSTINGER_LOCATION"; return 1; }
    validate_resource_name "$os_template" || { log_error "Invalid HOSTINGER_OS_TEMPLATE"; return 1; }

    log_warn "Creating Hostinger VPS '$name' (plan: $plan, location: $location)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(hostinger_api GET "/ssh-keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "keys")

    # Build request body — pipe cloud-init userdata via stdin to avoid bash quoting issues
    local userdata
    userdata=$(get_cloud_init_userdata)

    local body
    body=$(echo "$userdata" | python3 -c "
import json, sys
userdata = sys.stdin.read()
body = {
    'hostname': '$name',
    'plan': '$plan',
    'location': '$location',
    'os_template': '$os_template',
    'ssh_keys': $ssh_key_ids,
    'cloud_init': userdata,
    'start_after_create': True
}
print(json.dumps(body))
")

    local response
    response=$(hostinger_api POST "/virtual-machines" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"\|"message".*fail'; then
        log_error "Failed to create Hostinger VPS"

        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','') or d.get('error','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Plan/location unavailable (try different HOSTINGER_PLAN or HOSTINGER_LOCATION)"
        log_error "  - VPS limit reached for your account"
        log_error "  - Invalid cloud-init userdata"
        log_error ""
        log_error "Check your account status: https://hpanel.hostinger.com/"
        return 1
    fi

    # Extract VPS ID and IP
    HOSTINGER_VPS_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('id',''))")
    HOSTINGER_VPS_IP=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('ipv4',''))")
    export HOSTINGER_VPS_ID HOSTINGER_VPS_IP

    log_info "VPS created: ID=$HOSTINGER_VPS_ID, IP=$HOSTINGER_VPS_IP"
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # SSH_OPTS is defined in shared/common.sh
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

# Run a command on the server
run_server() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

# Upload a file to the server
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

# Destroy a Hostinger VPS
destroy_server() {
    local vps_id="$1"

    log_warn "Destroying VPS $vps_id..."
    local response
    response=$(hostinger_api DELETE "/virtual-machines/$vps_id")

    if echo "$response" | grep -q '"error"\|"message".*fail'; then
        log_error "Failed to destroy VPS: $response"
        return 1
    fi

    log_info "VPS $vps_id destroyed"
}

# List all Hostinger VPSs
list_servers() {
    local response
    response=$(hostinger_api GET "/virtual-machines")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
vpss = data.get('virtual_machines', [])
if not vpss:
    print('No VPS instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'PLAN':<10}\")
print('-' * 75)
for v in vpss:
    name = v.get('hostname', 'N/A')
    vid = str(v.get('id', 'N/A'))
    status = v.get('status', 'unknown')
    ip = v.get('ipv4', 'N/A')
    plan = v.get('plan', 'N/A')
    print(f'{name:<25} {vid:<12} {status:<12} {ip:<16} {plan:<10}')
" <<< "$response"
}
