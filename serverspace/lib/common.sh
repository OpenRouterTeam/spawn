#!/bin/bash
# Common bash functions for ServerSpace spawn scripts

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
# ServerSpace specific functions
# ============================================================

readonly SERVERSPACE_API_BASE="https://api.serverspace.io/api/v1"
SPAWN_DASHBOARD_URL="https://my.serverspace.io/"

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}
SERVERSPACE_TASK_TIMEOUT=${SERVERSPACE_TASK_TIMEOUT:-600}  # 10 minutes for async tasks

# ServerSpace API wrapper - uses X-API-KEY header
serverspace_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    local max_retries="${4:-3}"
    generic_cloud_api_custom_auth "$SERVERSPACE_API_BASE" "$method" "$endpoint" "$body" "$max_retries" \
        -H "X-API-KEY: ${SERVERSPACE_API_KEY}"
}

ensure_serverspace_token() {
    ensure_api_token_with_provider \
        "ServerSpace" \
        "SERVERSPACE_API_KEY" \
        "$HOME/.config/spawn/serverspace.json" \
        "https://my.serverspace.io/project/api" \
        test_serverspace_token
}

test_serverspace_token() {
    local response
    response=$(serverspace_api GET "/project")
    if printf '%s' "$response" | grep -q '"id"'; then
        return 0
    else
        return 1
    fi
}

get_server_name() {
    get_validated_server_name "SERVERSPACE_SERVER_NAME" "Enter server name: "
}

# Get location ID for the desired region
# Defaults to Amsterdam (nl1) if not specified
get_location_id() {
    local desired="${1:-nl1}"
    local response
    response=$(serverspace_api GET "/locations")
    local location_id
    location_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
desired = sys.argv[1].lower()
# Try exact match first
for loc in data:
    loc_id = loc.get('id', '')
    if loc_id.lower() == desired:
        print(loc_id)
        sys.exit(0)
# Try partial match on description/name
for loc in data:
    desc = loc.get('description', '').lower()
    name = loc.get('id', '').lower()
    if desired in desc or desired in name:
        print(loc['id'])
        sys.exit(0)
# Fallback: use the first location
if data:
    print(data[0]['id'])
    sys.exit(0)
sys.exit(1)
" "$desired" <<< "$response" 2>/dev/null)

    if [[ -z "$location_id" ]]; then
        log_error "Failed to find location matching '$desired'"
        log_error "Try a different SERVERSPACE_LOCATION"
        return 1
    fi

    echo "$location_id"
}

# Get Ubuntu image ID for a given location
get_ubuntu_image_id() {
    local location_id="${1:-nl1}"
    local response
    response=$(serverspace_api GET "/images")
    local image_id
    image_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
location = sys.argv[1]
best = None
for img in data:
    name = img.get('name', '').lower()
    os_name = img.get('os', '').lower()
    # Only consider images available in the target location
    locations = img.get('locations', [])
    if locations and location not in locations:
        continue
    if 'ubuntu' in name or 'ubuntu' in os_name:
        if '24.04' in name or 'noble' in name:
            print(img['id'])
            sys.exit(0)
        if '22.04' in name or 'jammy' in name:
            if best is None:
                best = img['id']
        elif best is None:
            best = img['id']
if best:
    print(best)
    sys.exit(0)
sys.exit(1)
" "$location_id" <<< "$response" 2>/dev/null)

    if [[ -z "$image_id" ]]; then
        log_error "Failed to find Ubuntu image for location $location_id"
        log_error "Try a different SERVERSPACE_LOCATION"
        return 1
    fi

    echo "$image_id"
}

# Check if SSH key is registered with ServerSpace
serverspace_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(serverspace_api GET "/ssh-keys")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
fp = sys.argv[1]
for key in data:
    if fp in key.get('fingerprint', ''):
        sys.exit(0)
sys.exit(1)
" "$fingerprint" <<< "$response" 2>/dev/null
}

# Register SSH key with ServerSpace
serverspace_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(serverspace_api POST "/ssh-keys" "$register_body")

    if printf '%s' "$register_response" | grep -q '"id"'; then
        return 0
    else
        local error_msg
        error_msg=$(printf '%s' "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider serverspace_check_ssh_key serverspace_register_ssh_key "ServerSpace"
}

# Get SSH key IDs from the account
get_ssh_key_ids() {
    local response
    response=$(serverspace_api GET "/ssh-keys")
    local ssh_key_ids
    ssh_key_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if data:
    ids = [str(k['id']) for k in data]
    print(json.dumps(ids))
" <<< "$response" 2>/dev/null)

    if [[ -z "$ssh_key_ids" || "$ssh_key_ids" == "[]" ]]; then
        log_error "No SSH keys found in your ServerSpace account"
        log_error "Register a key at: https://my.serverspace.io/project/ssh-keys"
        return 1
    fi

    echo "$ssh_key_ids"
}

# Wait for a ServerSpace async task to complete
# Usage: wait_for_task TASK_ID [TIMEOUT]
wait_for_task() {
    local task_id="$1"
    local timeout="${2:-$SERVERSPACE_TASK_TIMEOUT}"

    local elapsed=0
    log_step "Waiting for task to complete (timeout: ${timeout}s)..."

    while [[ "$elapsed" -lt "$timeout" ]]; do
        local task_response
        task_response=$(serverspace_api GET "/tasks/${task_id}")

        local is_done
        is_done=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print(data.get('is_done', False))
" <<< "$task_response" 2>/dev/null)

        if [[ "$is_done" == "True" ]]; then
            local error
            error=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print(data.get('error', '') or '')
" <<< "$task_response" 2>/dev/null)
            if [[ -n "$error" ]]; then
                log_error "Task failed: $error"
                return 1
            fi
            log_info "Task completed successfully"
            return 0
        fi

        log_step "Task status: pending (elapsed: ${elapsed}s)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
        elapsed=$((elapsed + INSTANCE_STATUS_POLL_DELAY))
    done

    log_error "Task timed out after ${timeout}s"
    return 1
}

# Generate cloud-init userdata script
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

# Build the JSON request body for server creation
# Usage: build_create_server_body NAME LOCATION_ID IMAGE_ID CPU RAM_MB DISK_MB SSH_KEY_IDS INIT_SCRIPT
build_create_server_body() {
    local name="$1" location_id="$2" image_id="$3"
    local cpu="$4" ram_mb="$5" disk_mb="$6"
    local ssh_key_ids="$7" init_script="$8"

    local json_script
    json_script=$(json_escape "$init_script")

    python3 -c "
import json, sys
script = json.loads(sys.stdin.read())
body = {
    'name': sys.argv[1],
    'location_id': sys.argv[2],
    'image_id': sys.argv[3],
    'cpu': int(sys.argv[4]),
    'ram_mb': int(sys.argv[5]),
    'volumes': [{'name': 'boot', 'size_mb': int(sys.argv[6])}],
    'ssh_key_ids': json.loads(sys.argv[7]),
    'networks': [{'bandwidth_mbps': 50}],
    'server_init_script': script
}
print(json.dumps(body))
" "$name" "$location_id" "$image_id" "$cpu" "$ram_mb" "$disk_mb" "$ssh_key_ids" <<< "$json_script"
}

# Handle ServerSpace instance creation API error response
_handle_serverspace_create_error() {
    local response="$1"

    log_error "Failed to create ServerSpace server"

    local error_msg
    error_msg=$(printf '%s' "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error', d.get('message', 'Unknown error')))" 2>/dev/null || echo "$response")
    log_error "API Error: $error_msg"

    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Location unavailable (try different SERVERSPACE_LOCATION)"
    log_warn "  - Resource limits reached"
    log_warn "Check your dashboard: https://my.serverspace.io/"
}

# Wait for ServerSpace server to become active and retrieve IP
# Sets: SERVERSPACE_SERVER_IP
# Usage: wait_for_serverspace_instance SERVER_ID [MAX_ATTEMPTS]
wait_for_serverspace_instance() {
    local server_id="$1"
    local max_attempts=${2:-60}

    local attempt=1
    log_step "Waiting for server to become active..."

    while [[ "$attempt" -le "$max_attempts" ]]; do
        local response
        response=$(serverspace_api GET "/servers/${server_id}")

        local status ip
        status=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print(data.get('status', ''))
" <<< "$response" 2>/dev/null)

        if [[ "$status" == "Active" ]]; then
            ip=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
nics = data.get('nics', [])
for nic in nics:
    ip_address = nic.get('ip_address', '')
    if ip_address:
        print(ip_address)
        sys.exit(0)
" <<< "$response" 2>/dev/null)

            if [[ -n "$ip" ]]; then
                SERVERSPACE_SERVER_IP="$ip"
                export SERVERSPACE_SERVER_IP
                log_info "Server active: IP=$SERVERSPACE_SERVER_IP"
                return 0
            fi
        fi

        log_step "Server status: ${status:-pending} (attempt $attempt/$max_attempts)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
        attempt=$((attempt + 1))
    done

    log_error "Timed out waiting for server to become active"
    return 1
}

create_server() {
    local name="$1"
    local location="${SERVERSPACE_LOCATION:-nl1}"
    local cpu="${SERVERSPACE_CPU:-1}"
    local ram="${SERVERSPACE_RAM:-1024}"
    local disk="${SERVERSPACE_DISK:-25600}"

    # Validate env var inputs
    validate_region_name "$location" || { log_error "Invalid SERVERSPACE_LOCATION"; return 1; }

    log_step "Creating ServerSpace server '$name' (location: $location, cpu: $cpu, ram: ${ram}MB)..."

    # Get location ID, image ID, and SSH key IDs
    local location_id image_id ssh_key_ids
    location_id=$(get_location_id "$location") || return 1
    image_id=$(get_ubuntu_image_id "$location_id") || return 1
    ssh_key_ids=$(get_ssh_key_ids) || return 1

    # Build request body with cloud-init
    local init_script
    init_script=$(get_cloud_init_userdata)

    local body
    body=$(build_create_server_body "$name" "$location_id" "$image_id" "$cpu" "$ram" "$disk" "$ssh_key_ids" "$init_script")

    local response
    response=$(serverspace_api POST "/servers" "$body")

    if ! printf '%s' "$response" | grep -q '"id"'; then
        _handle_serverspace_create_error "$response"
        return 1
    fi

    SERVERSPACE_SERVER_ID=$(printf '%s' "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])")
    export SERVERSPACE_SERVER_ID
    log_info "Server created: ID=$SERVERSPACE_SERVER_ID"

    wait_for_serverspace_instance "$SERVERSPACE_SERVER_ID"
}

# SSH operations — delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    log_step "Destroying server $server_id..."
    serverspace_api DELETE "/servers/$server_id"
    log_info "Server $server_id destroyed"
}

list_servers() {
    local response
    response=$(serverspace_api GET "/servers")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if not data:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'CPU':<6} {'RAM':<8}\")
print('-' * 107)
for s in data:
    name = s.get('name', 'N/A')
    sid = s.get('id', 'N/A')
    status = s.get('status', 'N/A')
    ip = 'N/A'
    for nic in s.get('nics', []):
        addr = nic.get('ip_address', '')
        if addr:
            ip = addr
            break
    cpu = s.get('cpu', 'N/A')
    ram = s.get('ram_mb', 'N/A')
    print(f'{name:<25} {str(sid):<40} {status:<12} {ip:<16} {str(cpu):<6} {str(ram):<8}')
" <<< "$response"
}
