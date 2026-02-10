#!/bin/bash
set -eo pipefail
# Common bash functions for Hyperstack spawn scripts

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
# Hyperstack specific functions
# ============================================================

readonly HYPERSTACK_API_BASE="https://infrahub-api.nexgencloud.com/v1"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for Hyperstack API
hyperstack_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    # shellcheck disable=SC2154
    generic_cloud_api "$HYPERSTACK_API_BASE" "$HYPERSTACK_API_KEY" "$method" "$endpoint" "$body" "api_key"
}

test_hyperstack_api_key() {
    local response
    response=$(hyperstack_api GET "/core/virtual-machines?per_page=1")
    if echo "$response" | grep -q '"status".*4[0-9][0-9]'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your API key at: https://infrahub.hyperstack.cloud"
        log_error "  2. Ensure the API key has proper permissions"
        log_error "  3. Check the key hasn't been revoked"
        return 1
    fi
    return 0
}

# Ensure HYPERSTACK_API_KEY is available (env var → config file → prompt+save)
ensure_hyperstack_api_key() {
    ensure_api_token_with_provider \
        "Hyperstack" \
        "HYPERSTACK_API_KEY" \
        "$HOME/.config/spawn/hyperstack.json" \
        "https://infrahub.hyperstack.cloud → Settings → API Keys" \
        "test_hyperstack_api_key"
}

# Check if SSH key is registered with Hyperstack
hyperstack_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(hyperstack_api GET "/core/keypairs")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Hyperstack
hyperstack_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(hyperstack_api POST "/core/keypairs" "$register_body")

    if echo "$register_response" | grep -q '"status".*4[0-9][0-9]'; then
        # Parse error details
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid ed25519 or RSA public key)"
        log_error "  - API key lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with Hyperstack
ensure_ssh_key() {
    ensure_ssh_key_with_provider hyperstack_check_ssh_key hyperstack_register_ssh_key "Hyperstack"
}

# Get VM name from env var or prompt
get_vm_name() {
    local vm_name
    vm_name=$(get_resource_name "HYPERSTACK_VM_NAME" "Enter VM name: ") || return 1

    if ! validate_server_name "$vm_name"; then
        return 1
    fi

    echo "$vm_name"
}

# Get environment name (required for VM creation)
get_environment_name() {
    local env_name="${HYPERSTACK_ENVIRONMENT:-}"

    if [[ -z "$env_name" ]]; then
        log_warn "Fetching available environments..."
        local envs_response
        envs_response=$(hyperstack_api GET "/core/environments")
        local env_list
        env_list=$(echo "$envs_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
envs = data.get('environments', [])
if envs:
    for env in envs[:5]:
        print(f\"  - {env['name']} (region: {env.get('region', 'N/A')})\")
" 2>/dev/null)

        if [[ -n "$env_list" ]]; then
            log_info "Available environments:"
            echo "$env_list" >&2
        fi

        env_name=$(safe_read "Enter environment name (e.g., default-CANADA-1): ")
    fi

    echo "$env_name"
}

# Create a Hyperstack VM
create_vm() {
    local name="$1"
    local environment="${2:-}"
    local flavor="${HYPERSTACK_FLAVOR:-n1-cpu-small}"
    local image="${HYPERSTACK_IMAGE:-Ubuntu Server 24.04 LTS R5504 UEFI}"
    local key_name="${HYPERSTACK_SSH_KEY_NAME:-spawn-key-$(whoami)}"

    # Validate env var inputs to prevent injection
    validate_resource_name "$flavor" || { log_error "Invalid HYPERSTACK_FLAVOR"; return 1; }
    validate_resource_name "$key_name" || { log_error "Invalid HYPERSTACK_SSH_KEY_NAME"; return 1; }

    log_warn "Creating Hyperstack VM '$name' (flavor: $flavor, env: $environment)..."

    # Build request body using stdin to prevent Python injection
    local body
    body=$(printf '%s\n%s\n%s\n%s\n%s' "$name" "$environment" "$key_name" "$image" "$flavor" | python3 -c "
import json, sys
lines = sys.stdin.read().split('\n')
body = {
    'name': lines[0],
    'environment_name': lines[1],
    'key_name': lines[2],
    'image_name': lines[3],
    'flavor_name': lines[4],
    'count': 1,
    'assign_floating_ip': True,
    'security_rules': [
        {
            'direction': 'ingress',
            'ethertype': 'IPv4',
            'protocol': 'tcp',
            'remote_ip_prefix': '0.0.0.0/0',
            'port_range_min': 22,
            'port_range_max': 22
        }
    ]
}
print(json.dumps(body))
")

    local response
    response=$(hyperstack_api POST "/core/virtual-machines" "$body")

    # Check for errors
    if echo "$response" | grep -q '"status".*4[0-9][0-9]'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "Failed to create VM: $error_msg"
        return 1
    fi

    # Extract VM details from response
    HYPERSTACK_VM_ID=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
vms = data.get('virtual_machines', [])
if vms:
    print(vms[0].get('id', ''))
")

    if [[ -z "$HYPERSTACK_VM_ID" ]]; then
        log_error "Failed to extract VM ID from response"
        return 1
    fi

    log_info "VM created with ID: $HYPERSTACK_VM_ID"

    # Wait for VM to become active and get IP
    log_warn "Waiting for VM to become active..."
    local max_wait=300
    local elapsed=0

    while [[ $elapsed -lt $max_wait ]]; do
        local vm_info
        vm_info=$(hyperstack_api GET "/core/virtual-machines/$HYPERSTACK_VM_ID")

        local status
        status=$(echo "$vm_info" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print(data.get('status', ''))
" 2>/dev/null)

        if [[ "$status" == "ACTIVE" ]]; then
            HYPERSTACK_VM_IP=$(echo "$vm_info" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print(data.get('floating_ip', ''))
" 2>/dev/null)

            if [[ -n "$HYPERSTACK_VM_IP" ]]; then
                log_info "VM is active with IP: $HYPERSTACK_VM_IP"
                export HYPERSTACK_VM_IP
                export HYPERSTACK_VM_ID
                return 0
            fi
        fi

        sleep 5
        elapsed=$((elapsed + 5))
    done

    log_error "VM did not become active within ${max_wait}s"
    return 1
}

# Verify server connectivity via SSH
verify_server_connectivity() {
    local ip="$1"
    generic_ssh_wait "$ip" "root" 180
}

# Run command on Hyperstack VM via SSH
run_server() {
    local ip="$1"
    shift
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$@"
}

# Upload file to Hyperstack VM via SCP
upload_file() {
    local ip="$1"
    local src="$2"
    local dst="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$src" "root@$ip:$dst"
}

# Start interactive session on Hyperstack VM
interactive_session() {
    local ip="$1"
    local cmd="${2:-bash}"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS -t "root@$ip" "$cmd"
}

# Ensure Python 3 is available on local machine
check_python_available
