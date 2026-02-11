#!/bin/bash
# Common bash functions for Scaleway spawn scripts

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

# Note: Provider-agnostic functions (logging, OAuth, browser, etc.) are now in shared/common.sh

# ============================================================
# Scaleway specific functions
# ============================================================

SCALEWAY_ZONE="${SCALEWAY_ZONE:-fr-par-1}"
readonly SCALEWAY_API_BASE="https://api.scaleway.com/instance/v1/zones/${SCALEWAY_ZONE}"
readonly SCALEWAY_ACCOUNT_API="https://api.scaleway.com/account/v3"
# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

# Scaleway API wrapper (uses X-Auth-Token header instead of Bearer) with retry logic
# Takes a full URL (not base+endpoint) for flexibility across Scaleway API namespaces
scaleway_api() {
    local method="$1"
    local url="$2"
    local body="${3:-}"
    local max_retries="${4:-3}"
    # Pass empty base_url since url is already complete
    generic_cloud_api_custom_auth "" "$method" "$url" "$body" "$max_retries" \
        -H "X-Auth-Token: ${SCW_SECRET_KEY}"
}

# Convenience wrapper for instance API
scaleway_instance_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    scaleway_api "$method" "${SCALEWAY_API_BASE}${endpoint}" "$body"
}

test_scaleway_token() {
    local response
    response=$(scaleway_instance_api GET "/servers?per_page=1")
    if echo "$response" | grep -q '"message"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_warn "Remediation steps:"
        log_warn "  1. Verify secret key at: https://console.scaleway.com/iam/api-keys"
        log_warn "  2. Ensure the key has appropriate permissions"
        log_warn "  3. Check key hasn't been revoked"
        return 1
    fi
    return 0
}

ensure_scaleway_token() {
    ensure_api_token_with_provider \
        "Scaleway" \
        "SCW_SECRET_KEY" \
        "$HOME/.config/spawn/scaleway.json" \
        "https://console.scaleway.com/iam/api-keys" \
        "test_scaleway_token"
}

# Get Scaleway project ID (required for creating resources)
get_scaleway_project_id() {
    if [[ -n "${SCW_DEFAULT_PROJECT_ID:-}" ]]; then
        echo "${SCW_DEFAULT_PROJECT_ID}"
        return 0
    fi

    # Try to get the default project from the API
    local response
    response=$(scaleway_api GET "${SCALEWAY_ACCOUNT_API}/projects?page_size=1&order_by=created_at_asc")
    local project_id
    project_id=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('projects',[{}])[0].get('id',''))" 2>/dev/null)

    if [[ -z "$project_id" ]]; then
        log_error "Failed to get Scaleway project ID"
        log_warn "Set SCW_DEFAULT_PROJECT_ID environment variable or check API permissions"
        return 1
    fi

    export SCW_DEFAULT_PROJECT_ID="$project_id"
    echo "$project_id"
}

# Extract best Ubuntu image ID from a Scaleway images API response
# Prefers 24.04/noble, then 22.04/jammy, then any image
_scaleway_pick_ubuntu_image() {
    python3 -c "
import json, sys
images = json.loads(sys.stdin.read()).get('images', [])
for img in images:
    name = img.get('name', '').lower()
    if '24.04' in name or 'noble' in name:
        print(img['id']); sys.exit(0)
for img in images:
    name = img.get('name', '').lower()
    if '22.04' in name or 'jammy' in name:
        print(img['id']); sys.exit(0)
if images:
    print(images[0]['id'])
" 2>/dev/null
}

# Get Ubuntu image ID for the current zone
get_ubuntu_image_id() {
    log_warn "Looking up Ubuntu image for zone ${SCALEWAY_ZONE}..."

    # Try specific 24.04 search first, then broader Ubuntu search
    local image_id="" query
    for query in "Ubuntu+24.04+Jammy+Jellyfish" "Ubuntu"; do
        local response
        response=$(scaleway_instance_api GET "/images?name=${query}&arch=x86_64&per_page=50")
        image_id=$(echo "$response" | _scaleway_pick_ubuntu_image)
        if [[ -n "$image_id" ]]; then
            echo "$image_id"
            return 0
        fi
    done

    log_error "Could not find Ubuntu image for zone ${SCALEWAY_ZONE}"
    return 1
}

# Check if SSH key is registered with Scaleway
scaleway_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(scaleway_api GET "${SCALEWAY_ACCOUNT_API}/ssh-keys?per_page=50")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with Scaleway
scaleway_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    local project_id
    project_id=$(get_scaleway_project_id) || return 1

    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")

    local register_body
    register_body=$(python3 -c "
import json, sys
pub_key = json.loads(sys.stdin.read())
body = {
    'name': '$key_name',
    'public_key': pub_key,
    'project_id': '$project_id'
}
print(json.dumps(body))
" <<< "$json_pub_key")

    local register_response
    register_response=$(scaleway_api POST "${SCALEWAY_ACCOUNT_API}/ssh-keys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider scaleway_check_ssh_key scaleway_register_ssh_key "Scaleway"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "SCALEWAY_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Parse Scaleway server response to extract public IP address
_scaleway_extract_ip() {
    python3 -c "
import json, sys
server = json.loads(sys.stdin.read())['server']
ip = server.get('public_ip', {})
if ip:
    print(ip.get('address', ''))
else:
    ips = server.get('public_ips', [])
    for pip in ips:
        if pip.get('address'):
            print(pip['address'])
            sys.exit(0)
    print('')
"
}

# Power on and wait for Scaleway instance to become running with a public IP
# Sets SCALEWAY_SERVER_IP on success
_scaleway_power_on_and_wait() {
    local server_id="$1"

    log_warn "Powering on instance..."
    local action_response
    action_response=$(scaleway_instance_api POST "/servers/${server_id}/action" '{"action":"poweron"}')

    if echo "$action_response" | grep -q '"task"'; then
        log_info "Power on initiated"
    else
        log_warn "Power on may have failed, checking status..."
    fi

    log_warn "Waiting for instance to become active..."
    local max_attempts=60
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response
        status_response=$(scaleway_instance_api GET "/servers/$server_id")
        local state
        state=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['state'])")

        if [[ "$state" == "running" ]]; then
            SCALEWAY_SERVER_IP=$(echo "$status_response" | _scaleway_extract_ip)
            if [[ -n "$SCALEWAY_SERVER_IP" ]]; then
                export SCALEWAY_SERVER_IP
                log_info "Instance active: IP=$SCALEWAY_SERVER_IP"
                return 0
            fi
        fi

        log_warn "Instance state: $state ($attempt/$max_attempts)"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become active in time"
    return 1
}

create_server() {
    local name="$1"
    local commercial_type="${SCALEWAY_TYPE:-DEV1-S}"
    local zone="${SCALEWAY_ZONE:-fr-par-1}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$commercial_type" || { log_error "Invalid SCALEWAY_TYPE"; return 1; }
    validate_region_name "$zone" || { log_error "Invalid SCALEWAY_ZONE"; return 1; }

    log_warn "Creating Scaleway instance '$name' (type: $commercial_type, zone: $zone)..."

    local project_id
    project_id=$(get_scaleway_project_id) || return 1

    local image_id
    image_id=$(get_ubuntu_image_id) || return 1
    log_info "Using image: $image_id"

    local body
    body=$(python3 -c "
import json
body = {
    'name': '$name',
    'commercial_type': '$commercial_type',
    'image': '$image_id',
    'project': '$project_id',
    'dynamic_ip_required': True
}
print(json.dumps(body))
")

    local response
    response=$(scaleway_instance_api POST "/servers" "$body")

    if echo "$response" | grep -q '"server"'; then
        SCALEWAY_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
        export SCALEWAY_SERVER_ID
        log_info "Instance created: ID=$SCALEWAY_SERVER_ID"
    else
        log_error "Failed to create Scaleway instance"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Commercial type unavailable in zone (try different SCALEWAY_TYPE or SCALEWAY_ZONE)"
        log_warn "  - Instance limit reached"
        log_warn "Remediation: Check https://console.scaleway.com/"
        return 1
    fi

    _scaleway_power_on_and_wait "$SCALEWAY_SERVER_ID"
}

verify_server_connectivity() { ssh_verify_connectivity "$@"; }

wait_for_server_ready() {
    local ip="$1"
    local max_attempts=${2:-60}
    # Scaleway doesn't use cloud-init by default, so we wait for basic tools
    log_warn "Waiting for server to be ready..."
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "command -v curl" "server readiness" "$max_attempts" 5
}

install_base_packages() {
    local ip="$1"
    log_warn "Installing base packages..."
    run_server "$ip" "apt-get update -qq && apt-get install -y -qq curl unzip git zsh >/dev/null 2>&1"
    log_warn "Installing Bun..."
    run_server "$ip" "curl -fsSL https://bun.sh/install | bash"
    log_warn "Installing Node.js..."
    run_server "$ip" "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y -qq nodejs >/dev/null 2>&1"
    # Set up PATH in shell configs
    run_server "$ip" "printf 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"\n' >> /root/.bashrc"
    run_server "$ip" "printf 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"\n' >> /root/.zshrc"
    log_info "Base packages installed"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_warn "Destroying instance $server_id..."

    # Scaleway requires powering off before deleting
    scaleway_instance_api POST "/servers/$server_id/action" '{"action":"poweroff"}' >/dev/null 2>&1 || true
    sleep 5

    # Delete the server (terminate also deletes attached volumes/IPs)
    scaleway_instance_api POST "/servers/$server_id/action" '{"action":"terminate"}' >/dev/null 2>&1 || true
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local response
    response=$(scaleway_instance_api GET "/servers")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATE':<12} {'IP':<16} {'TYPE':<10}\")
print('-' * 103)
for s in servers:
    name = s['name']
    sid = s['id']
    state = s['state']
    ip_data = s.get('public_ip') or {}
    ip = ip_data.get('address', 'N/A') if ip_data else 'N/A'
    stype = s.get('commercial_type', 'N/A')
    print(f'{name:<25} {sid:<40} {state:<12} {ip:<16} {stype:<10}')
" <<< "$response"
}
