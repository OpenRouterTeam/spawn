#!/bin/bash
# Common bash functions for Civo spawn scripts

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
# Civo specific functions
# ============================================================

readonly CIVO_API_BASE="https://api.civo.com/v2"

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

civo_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$CIVO_API_BASE" "$CIVO_API_TOKEN" "$method" "$endpoint" "$body"
}

ensure_civo_token() {
    ensure_api_token_with_provider \
        "Civo" \
        "CIVO_API_TOKEN" \
        "$HOME/.config/spawn/civo.json" \
        "https://dashboard.civo.com/security" \
        test_civo_token
}

test_civo_token() {
    local response
    response=$(civo_api GET "/regions")
    if echo "$response" | grep -q '"code"'; then
        return 0
    else
        return 1
    fi
}

# Check if SSH key is registered with Civo
civo_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(civo_api GET "/sshkeys")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Civo
civo_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(civo_api POST "/sshkeys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('reason','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider civo_check_ssh_key civo_register_ssh_key "Civo"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "CIVO_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Get the default network ID for the region
get_default_network_id() {
    local region="${1:-lon1}"
    local response
    response=$(civo_api GET "/networks?region=$region")
    local network_id
    network_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for n in data:
    if n.get('default', False):
        print(n['id'])
        sys.exit(0)
# Fallback: use the first network
if data:
    print(data[0]['id'])
" <<< "$response" 2>/dev/null)

    if [[ -z "$network_id" ]]; then
        log_error "Failed to find a network in region $region"
        return 1
    fi

    echo "$network_id"
}

# Get Ubuntu disk image template ID
get_ubuntu_template_id() {
    local region="${1:-lon1}"
    local response
    response=$(civo_api GET "/disk_images?region=${region}")
    local template_id
    template_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
# Look for Ubuntu 24.04 first, then any Ubuntu
best = None
for img in data:
    name = img.get('name', '').lower()
    label = img.get('label', '').lower()
    if 'ubuntu' in name or 'ubuntu' in label:
        if '24.04' in name or '24.04' in label or 'noble' in name:
            print(img['id'])
            sys.exit(0)
        if best is None:
            best = img['id']
if best:
    print(best)
    sys.exit(0)
sys.exit(1)
" <<< "$response" 2>/dev/null)

    if [[ -z "$template_id" ]]; then
        log_error "Failed to find Ubuntu disk image"
        return 1
    fi

    echo "$template_id"
}

# Get SSH key ID
get_ssh_key_id() {
    local response
    response=$(civo_api GET "/sshkeys")
    local ssh_key_id
    ssh_key_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if data:
    print(data[0]['id'])
" <<< "$response" 2>/dev/null)

    if [[ -z "$ssh_key_id" ]]; then
        log_error "No SSH keys found"
        return 1
    fi

    echo "$ssh_key_id"
}

# Generate cloud-init userdata script for Civo instances
get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
set -e
apt-get update -qq
apt-get install -y -qq curl unzip git zsh
# Install Bun
curl -fsSL https://bun.sh/install | bash
# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
# Configure PATH
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.bashrc
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.zshrc
# Signal completion
touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

# Build the JSON request body for instance creation
# Usage: build_create_instance_body NAME SIZE REGION NETWORK_ID TEMPLATE_ID SSH_KEY_ID INIT_SCRIPT
build_create_instance_body() {
    local name="$1" size="$2" region="$3"
    local network_id="$4" template_id="$5" ssh_key_id="$6"
    local init_script="$7"

    local json_script
    json_script=$(json_escape "$init_script")

    python3 -c "
import json, sys
script = json.loads(sys.stdin.read())
body = {
    'hostname': '$name',
    'size': '$size',
    'region': '$region',
    'network_id': '$network_id',
    'template_id': '$template_id',
    'ssh_key_id': '$ssh_key_id',
    'initial_user': 'root',
    'script': script,
    'public_ip': 'create'
}
print(json.dumps(body))
" <<< "$json_script"
}

# Wait for a Civo instance to become ACTIVE and retrieve its public IP
# Sets: CIVO_SERVER_IP
# Usage: wait_for_civo_instance SERVER_ID [MAX_ATTEMPTS]
wait_for_civo_instance() {
    local server_id="$1"
    local max_attempts=${2:-60}

    log_warn "Waiting for instance to become active..."
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        local region="${CIVO_REGION:-lon1}"
        status_response=$(civo_api GET "/instances/$server_id?region=$region")
        local status
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('status',''))")

        if [[ "$status" == "ACTIVE" ]]; then
            CIVO_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('public_ip',''))")
            export CIVO_SERVER_IP
            if [[ -n "$CIVO_SERVER_IP" ]]; then
                log_info "Instance active: IP=$CIVO_SERVER_IP"
                return 0
            fi
        fi

        log_warn "Instance status: $status ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become active in time"
    return 1
}

# Handle Civo instance creation API error response
# Usage: _handle_civo_create_error RESPONSE
_handle_civo_create_error() {
    local response="$1"

    log_error "Failed to create Civo instance"

    local error_msg
    error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('reason', d.get('message', 'Unknown error')))" 2>/dev/null || echo "$response")
    log_error "API Error: $error_msg"

    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Size unavailable in region (try different CIVO_SIZE or CIVO_REGION)"
    log_warn "  - Instance limit reached"
    log_warn "Remediation: Check https://dashboard.civo.com/"
}

create_server() {
    local name="$1"
    local size="${CIVO_SIZE:-g4s.small}"
    local region="${CIVO_REGION:-lon1}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$size" || { log_error "Invalid CIVO_SIZE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid CIVO_REGION"; return 1; }

    log_warn "Creating Civo instance '$name' (size: $size, region: $region)..."

    # Gather required resource IDs
    local network_id template_id ssh_key_id
    network_id=$(get_default_network_id "$region") || return 1
    template_id=$(get_ubuntu_template_id "$region") || return 1
    ssh_key_id=$(get_ssh_key_id) || return 1

    # Build request body with cloud-init userdata
    local init_script
    init_script=$(get_cloud_init_userdata)

    local body
    body=$(build_create_instance_body "$name" "$size" "$region" "$network_id" "$template_id" "$ssh_key_id" "$init_script")

    local response
    response=$(civo_api POST "/instances" "$body")

    if ! echo "$response" | grep -q '"id"'; then
        _handle_civo_create_error "$response"
        return 1
    fi

    CIVO_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])")
    export CIVO_SERVER_ID
    log_info "Instance created: ID=$CIVO_SERVER_ID"

    wait_for_civo_instance "$CIVO_SERVER_ID"
}

verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

run_server() {
    local ip="$1"; local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

upload_file() {
    local ip="$1"; local local_path="$2"; local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

interactive_session() {
    local ip="$1"; local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

destroy_server() {
    local server_id="$1"
    local region="${CIVO_REGION:-lon1}"
    log_warn "Destroying instance $server_id..."
    civo_api DELETE "/instances/$server_id?region=$region"
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local region="${CIVO_REGION:-lon1}"
    local response
    response=$(civo_api GET "/instances?region=$region")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
items = data.get('items', data) if isinstance(data, dict) else data
if not items:
    print('No instances found')
    sys.exit(0)
if isinstance(items, list):
    instances = items
else:
    instances = items.get('items', [])
print(f\"{'HOSTNAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'SIZE':<15}\")
print('-' * 108)
for i in instances:
    hostname = i.get('hostname', 'N/A')
    iid = i['id']
    status = i.get('status', 'N/A')
    ip = i.get('public_ip', 'N/A')
    size = i.get('size', 'N/A')
    print(f'{hostname:<25} {iid:<40} {status:<12} {ip:<16} {size:<15}')
" <<< "$response"
}
