#!/bin/bash
# Common bash functions for Gcore spawn scripts

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
# Gcore specific functions
# ============================================================

readonly GCORE_API_BASE="https://api.gcore.com"
SPAWN_DASHBOARD_URL="https://portal.gcore.com/"

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

# Gcore API uses "apikey" auth header (not Bearer)
gcore_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api_custom_auth "$GCORE_API_BASE" "$method" "$endpoint" "$body" 3 \
        -H "Authorization: apikey ${GCORE_API_TOKEN}"
}

ensure_gcore_token() {
    ensure_api_token_with_provider \
        "Gcore" \
        "GCORE_API_TOKEN" \
        "$HOME/.config/spawn/gcore.json" \
        "https://portal.gcore.com/cloud/profile/api-tokens" \
        test_gcore_token
}

test_gcore_token() {
    local response
    response=$(gcore_api GET "/cloud/v1/regions/${GCORE_PROJECT_ID:-}")
    # If no project ID set yet, try listing projects instead
    if [[ -z "${GCORE_PROJECT_ID:-}" ]]; then
        response=$(gcore_api GET "/cloud/v1/projects")
    fi
    if echo "$response" | grep -q '"id"'; then
        return 0
    else
        return 1
    fi
}

# Ensure project ID is set (required for all Gcore cloud API calls)
ensure_gcore_project() {
    if [[ -n "${GCORE_PROJECT_ID:-}" ]]; then
        log_info "Using Gcore project ID from environment"
        return 0
    fi

    # Try loading from config
    local config_file="$HOME/.config/spawn/gcore.json"
    if [[ -f "$config_file" ]]; then
        local saved_project
        saved_project=$(python3 -c "import json; d=json.load(open('$config_file')); print(d.get('project_id',''))" 2>/dev/null || true)
        if [[ -n "$saved_project" ]]; then
            GCORE_PROJECT_ID="$saved_project"
            export GCORE_PROJECT_ID
            log_info "Using Gcore project ID from config"
            return 0
        fi
    fi

    # Auto-detect: use the first available project
    local response
    response=$(gcore_api GET "/cloud/v1/projects")
    local project_id
    project_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
projects = data if isinstance(data, list) else data.get('results', data.get('projects', []))
if projects:
    print(projects[0]['id'])
" <<< "$response" 2>/dev/null)

    if [[ -z "$project_id" ]]; then
        log_error "Failed to detect Gcore project ID"
        log_error "Set GCORE_PROJECT_ID environment variable manually"
        return 1
    fi

    GCORE_PROJECT_ID="$project_id"
    export GCORE_PROJECT_ID
    log_info "Auto-detected Gcore project: $GCORE_PROJECT_ID"

    # Save to config
    if [[ -f "$config_file" ]]; then
        python3 -c "
import json
with open('$config_file', 'r+') as f:
    d = json.load(f)
    d['project_id'] = '$project_id'
    f.seek(0); f.truncate()
    json.dump(d, f, indent=2)
" 2>/dev/null || true
    fi
}

# Check if SSH key is registered with Gcore
gcore_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(gcore_api GET "/cloud/v1/ssh_keys/${GCORE_PROJECT_ID}")
    local results
    results=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
items = data.get('results', data if isinstance(data, list) else [])
for k in items:
    print(k.get('fingerprint', ''))
" <<< "$response" 2>/dev/null)
    echo "$results" | grep -q "$fingerprint"
}

# Register SSH key with Gcore
gcore_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key json_name
    json_pub_key=$(json_escape "$pub_key")
    json_name=$(json_escape "$key_name")
    local register_body="{\"name\":$json_name,\"public_key\":$json_pub_key,\"project_id\":${GCORE_PROJECT_ID}}"
    local register_response
    register_response=$(gcore_api POST "/cloud/v1/ssh_keys/${GCORE_PROJECT_ID}" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message', d.get('detail', 'Unknown error')))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider gcore_check_ssh_key gcore_register_ssh_key "Gcore"
}

get_server_name() {
    get_validated_server_name "GCORE_SERVER_NAME" "Enter server name: "
}

# Get Ubuntu image ID
get_ubuntu_image_id() {
    local region="${1:-ed-1}"
    local response
    response=$(gcore_api GET "/cloud/v1/images/${GCORE_PROJECT_ID}/${region}")
    local image_id
    image_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
images = data.get('results', data if isinstance(data, list) else [])
best = None
for img in images:
    name = img.get('display_name', img.get('name', '')).lower()
    os_distro = img.get('os_distro', '').lower()
    if 'ubuntu' in name or 'ubuntu' in os_distro:
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
" <<< "$response" 2>/dev/null)

    if [[ -z "$image_id" ]]; then
        log_error "Failed to find Ubuntu image in region ${region}"
        log_error "Try a different GCORE_REGION"
        return 1
    fi

    echo "$image_id"
}

# Get the first available flavor matching our requirements
get_flavor_id() {
    local region="${1:-ed-1}"
    local desired_flavor="${GCORE_FLAVOR:-g1-standard-1-2}"
    local response
    response=$(gcore_api GET "/cloud/v1/flavors/${GCORE_PROJECT_ID}/${region}")
    local flavor_name
    flavor_name=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
flavors = data.get('results', data if isinstance(data, list) else [])
desired = sys.argv[1]
# Try exact match first
for f in flavors:
    if f.get('name', '') == desired or f.get('flavor_id', '') == desired:
        print(f.get('flavor_id', f.get('name', '')))
        sys.exit(0)
# Fallback: find any small flavor (1-2 vCPUs, 1-4 GB RAM)
for f in flavors:
    vcpus = f.get('vcpus', 0)
    ram = f.get('ram', 0)
    if 1 <= vcpus <= 2 and 1024 <= ram <= 4096:
        print(f.get('flavor_id', f.get('name', '')))
        sys.exit(0)
# Last resort: use first available
if flavors:
    print(flavors[0].get('flavor_id', flavors[0].get('name', '')))
    sys.exit(0)
sys.exit(1)
" "$desired_flavor" <<< "$response" 2>/dev/null)

    if [[ -z "$flavor_name" ]]; then
        log_error "Failed to find a suitable flavor in region ${region}"
        log_error "Try a different GCORE_REGION or set GCORE_FLAVOR"
        return 1
    fi

    echo "$flavor_name"
}

# Get SSH key name for instance creation
get_ssh_key_name() {
    local response
    response=$(gcore_api GET "/cloud/v1/ssh_keys/${GCORE_PROJECT_ID}")
    local ssh_key_name
    ssh_key_name=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
items = data.get('results', data if isinstance(data, list) else [])
if items:
    # Prefer a key with 'spawn' in the name
    for k in items:
        if 'spawn' in k.get('name', '').lower():
            print(k['name'])
            sys.exit(0)
    print(items[0]['name'])
" <<< "$response" 2>/dev/null)

    if [[ -z "$ssh_key_name" ]]; then
        log_error "No SSH keys found in your Gcore account"
        log_error "Register a key at: https://portal.gcore.com/cloud/ssh-keys"
        return 1
    fi

    echo "$ssh_key_name"
}

# Generate cloud-init userdata script for Gcore instances
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
build_create_instance_body() {
    local name="$1" flavor="$2" region="$3"
    local image_id="$4" ssh_key_name="$5"
    local init_script="$6"

    python3 -c "
import json, sys

name = sys.argv[1]
flavor = sys.argv[2]
region = sys.argv[3]
image_id = sys.argv[4]
ssh_key_name = sys.argv[5]
user_data = sys.stdin.read()

body = {
    'name': name,
    'flavor': flavor,
    'keypair_name': ssh_key_name,
    'volumes': [{
        'source': 'image',
        'image_id': image_id,
        'size': 20,
        'boot_index': 0,
        'delete_on_termination': True
    }],
    'interfaces': [{
        'type': 'external'
    }],
    'user_data': user_data
}
print(json.dumps(body))
" "$name" "$flavor" "$region" "$image_id" "$ssh_key_name" <<< "$init_script"
}

# Wait for a Gcore instance to become ACTIVE and retrieve its public IP
# Sets: GCORE_SERVER_IP
wait_for_gcore_instance() {
    local server_id="$1"
    local max_attempts=${2:-60}
    local region="${GCORE_REGION:-ed-1}"
    generic_wait_for_instance gcore_api "/cloud/v1/instances/${GCORE_PROJECT_ID}/${region}/${server_id}" \
        "active" "d.get('vm_state',d.get('status','').lower())" \
        "[a.get('addr','') for net in d.get('addresses',{}).values() for a in net if a.get('type','')=='fixed' and '.' in a.get('addr','')][0] if d.get('addresses') else ''" \
        GCORE_SERVER_IP "Instance" "${max_attempts}"
}

# Handle Gcore instance creation API error response
_handle_gcore_create_error() {
    local response="$1"

    log_error "Failed to create Gcore instance"

    local error_msg
    error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message', d.get('detail', 'Unknown error')))" 2>/dev/null || echo "$response")
    log_error "API Error: $error_msg"

    log_warn "Common issues:"
    log_warn "  - Insufficient account balance"
    log_warn "  - Flavor unavailable in region (try different GCORE_FLAVOR or GCORE_REGION)"
    log_warn "  - Instance limit reached"
    log_warn "Check your dashboard: https://portal.gcore.com/"
}

# Gather all required resource IDs for instance creation
_gather_instance_resources() {
    local region="$1"
    local flavor image_id ssh_key_name

    flavor=$(get_flavor_id "$region") || return 1
    image_id=$(get_ubuntu_image_id "$region") || return 1
    ssh_key_name=$(get_ssh_key_name) || return 1

    log_info "Using flavor: $flavor, image: $image_id"

    echo "$flavor|$image_id|$ssh_key_name"
}

# Extract instance ID from API response
_extract_instance_id() {
    local response="$1"

    echo "$response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
# v2 returns {\"tasks\": [\"task-uuid\"], \"instances\": [\"instance-uuid\"]}
instances = d.get('instances', [])
if instances:
    print(instances[0])
    sys.exit(0)
# Fallback: try direct id field
if 'id' in d:
    print(d['id'])
    sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

create_server() {
    local name="$1"
    local region="${GCORE_REGION:-ed-1}"

    # Validate env var inputs
    validate_region_name "$region" || { log_error "Invalid GCORE_REGION"; return 1; }

    log_step "Creating Gcore instance '$name' (region: $region)..."

    # Gather required resource IDs
    local resources
    resources=$(_gather_instance_resources "$region") || return 1
    IFS='|' read -r flavor image_id ssh_key_name <<< "$resources"

    # Build request body with cloud-init userdata
    local init_script
    init_script=$(get_cloud_init_userdata)

    local body
    body=$(build_create_instance_body "$name" "$flavor" "$region" "$image_id" "$ssh_key_name" "$init_script")

    local response
    response=$(gcore_api POST "/cloud/v2/instances/${GCORE_PROJECT_ID}/${region}" "$body")

    # Extract instance ID from response
    local instance_id
    instance_id=$(_extract_instance_id "$response")

    if [[ -z "${instance_id:-}" ]]; then
        _handle_gcore_create_error "$response"
        return 1
    fi

    GCORE_SERVER_ID="$instance_id"
    export GCORE_SERVER_ID
    log_info "Instance created: ID=$GCORE_SERVER_ID"

    wait_for_gcore_instance "$GCORE_SERVER_ID"
}

# SSH operations -- delegates to shared helpers (SSH_USER defaults to root)
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

destroy_server() {
    local server_id="$1"
    local region="${GCORE_REGION:-ed-1}"
    log_step "Destroying instance $server_id..."
    gcore_api DELETE "/cloud/v1/instances/${GCORE_PROJECT_ID}/${region}/$server_id"
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local region="${GCORE_REGION:-ed-1}"
    local response
    response=$(gcore_api GET "/cloud/v1/instances/${GCORE_PROJECT_ID}/${region}")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
items = data.get('results', data if isinstance(data, list) else [])
if not items:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'FLAVOR':<15}\")
print('-' * 108)
for i in items:
    name = i.get('name', 'N/A')
    iid = i['id']
    status = i.get('vm_state', i.get('status', 'N/A'))
    flavor = i.get('flavor', {}).get('flavor_id', i.get('flavor', {}).get('name', 'N/A')) if isinstance(i.get('flavor'), dict) else i.get('flavor', 'N/A')
    ip = 'N/A'
    for net_addrs in i.get('addresses', {}).values():
        for a in net_addrs:
            if a.get('type') == 'fixed' and '.' in a.get('addr', ''):
                ip = a['addr']
                break
        if ip != 'N/A':
            break
    print(f'{name:<25} {iid:<40} {status:<12} {ip:<16} {flavor:<15}')
" <<< "$response"
}
