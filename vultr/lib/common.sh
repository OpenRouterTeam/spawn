#!/bin/bash
# Common bash functions for Vultr spawn scripts

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
# Vultr specific functions
# ============================================================

readonly VULTR_API_BASE="https://api.vultr.com/v2"
SPAWN_DASHBOARD_URL="https://my.vultr.com/"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

vultr_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$VULTR_API_BASE" "$VULTR_API_KEY" "$method" "$endpoint" "$body"
}

test_vultr_token() {
    local response
    response=$(vultr_api GET "/account")
    if echo "$response" | grep -q '"account"'; then
        log_info "API key validated"
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$response" "Unable to parse error")"
        log_error "How to fix:"
        log_warn "  1. Verify API key at: https://my.vultr.com/settings/#settingsapi"
        log_warn "  2. Ensure the key has appropriate permissions"
        log_warn "  3. Check key hasn't been revoked"
        return 1
    fi
}

ensure_vultr_token() {
    ensure_api_token_with_provider \
        "Vultr" \
        "VULTR_API_KEY" \
        "$HOME/.config/spawn/vultr.json" \
        "https://my.vultr.com/settings/#settingsapi" \
        "test_vultr_token"
}

# Check if SSH key is registered with Vultr
vultr_check_ssh_key() {
    check_ssh_key_by_fingerprint vultr_api "/ssh-keys" "$1"
}

# Register SSH key with Vultr
vultr_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"ssh_key\":$json_pub_key}"
    local register_response
    register_response=$(vultr_api POST "/ssh-keys" "$register_body")

    if echo "$register_response" | grep -q '"ssh_key"'; then
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$register_response" "$register_response")"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider vultr_check_ssh_key vultr_register_ssh_key "Vultr"
}

get_server_name() {
    get_validated_server_name "VULTR_SERVER_NAME" "Enter server name: "
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Build JSON request body for Vultr instance creation
# Usage: _vultr_build_instance_body NAME PLAN REGION OS_ID SSH_KEY_IDS USERDATA_B64
_vultr_build_instance_body() {
    local name="$1" plan="$2" region="$3" os_id="$4" ssh_key_ids="$5" userdata_b64="$6"
    python3 -c "
import json, sys
name, plan, region, os_id, ssh_key_ids, userdata_b64 = sys.argv[1:7]
body = {
    'label': name,
    'hostname': name,
    'region': region,
    'plan': plan,
    'os_id': int(os_id),
    'sshkey_id': json.loads(ssh_key_ids),
    'user_data': userdata_b64,
    'backups': 'disabled'
}
print(json.dumps(body))
" "$name" "$plan" "$region" "$os_id" "$ssh_key_ids" "$userdata_b64"
}

# Wait for Vultr instance to become active and get its IP
# Sets: VULTR_SERVER_IP
# Usage: _wait_for_vultr_instance INSTANCE_ID [MAX_ATTEMPTS]
_wait_for_vultr_instance() {
    local instance_id="$1"
    local max_attempts=${2:-60}
    generic_wait_for_instance vultr_api "/instances/${instance_id}" \
        "active/running" \
        "d['instance']['status']+'/'+d['instance']['power_status']" \
        "d['instance']['main_ip']" \
        VULTR_SERVER_IP "Instance" "${max_attempts}"
}

create_server() {
    local name="$1"
    local plan="${VULTR_PLAN:-vc2-1c-2gb}"
    local region="${VULTR_REGION:-ewr}"
    # Ubuntu 24.04 x64 OS ID
    local os_id="${VULTR_OS_ID:-2284}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$plan" || { log_error "Invalid VULTR_PLAN"; return 1; }
    validate_region_name "$region" || { log_error "Invalid VULTR_REGION"; return 1; }
    if [[ ! "$os_id" =~ ^[0-9]+$ ]]; then log_error "Invalid VULTR_OS_ID: must be numeric"; return 1; fi

    log_step "Creating Vultr instance '$name' (plan: $plan, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(vultr_api GET "/ssh-keys")
    local ssh_key_ids
    ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_b64
    userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    local body
    body=$(_vultr_build_instance_body "$name" "$plan" "$region" "$os_id" "$ssh_key_ids" "$userdata_b64")

    local response
    response=$(vultr_api POST "/instances" "$body")

    if echo "$response" | grep -q '"instance"'; then
        VULTR_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['id'])")
        export VULTR_SERVER_ID
        log_info "Instance created: ID=$VULTR_SERVER_ID"
    else
        log_error "Failed to create Vultr instance"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Plan/region unavailable (try different VULTR_PLAN or VULTR_REGION)"
        log_warn "  - Instance limit reached"
        log_warn "  - Invalid cloud-init userdata"
        log_warn "Check your dashboard: https://my.vultr.com/"
        return 1
    fi

    _wait_for_vultr_instance "$VULTR_SERVER_ID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_step "Destroying instance $server_id..."
    vultr_api DELETE "/instances/$server_id"
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local response
    response=$(vultr_api GET "/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('instances', [])
if not instances:
    print('No instances found')
    sys.exit(0)
print(f\"{'LABEL':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'PLAN':<15}\")
print('-' * 108)
for i in instances:
    label = i.get('label', 'N/A')
    iid = i['id']
    status = i['status']
    ip = i.get('main_ip', 'N/A')
    plan = i['plan']
    print(f'{label:<25} {iid:<40} {status:<12} {ip:<16} {plan:<15}')
" <<< "$response"
}
