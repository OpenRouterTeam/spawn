#!/bin/bash
set -eo pipefail
# Common bash functions for OVHcloud spawn scripts

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    _shared_common=$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh) || {
        echo "ERROR: Failed to load shared/common.sh from GitHub" >&2
        echo "Check your network connection and try again" >&2
        exit 1
    }
    eval "$_shared_common"
    unset _shared_common
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# OVHcloud specific functions
# ============================================================

readonly OVH_API_BASE="https://eu.api.ovh.com/1.0"
SPAWN_DASHBOARD_URL="https://www.ovhcloud.com/manager/"

# OVH API requires signature-based authentication.
# Headers: X-Ovh-Application, X-Ovh-Consumer, X-Ovh-Timestamp, X-Ovh-Signature
# Signature = "$1$" + SHA1(APP_SECRET + "+" + CONSUMER_KEY + "+" + METHOD + "+" + FULL_URL + "+" + BODY + "+" + TIMESTAMP)

# Get OVH server timestamp (for clock sync)
_ovh_get_timestamp() {
    curl -s "${OVH_API_BASE}/auth/time" 2>/dev/null || date +%s
}

# Compute OVH API signature
# Usage: _ovh_sign METHOD FULL_URL BODY TIMESTAMP
_ovh_sign() {
    local method="$1"
    local url="$2"
    local body="$3"
    local timestamp="$4"

    local sig_data="${OVH_APPLICATION_SECRET}+${OVH_CONSUMER_KEY}+${method}+${url}+${body}+${timestamp}"
    local hash
    hash=$(printf '%s' "${sig_data}" | openssl dgst -sha1 2>/dev/null | awk '{print $NF}')
    printf '$1$%s' "${hash}"
}

# Centralized curl wrapper for OVH API with signature auth
# Usage: ovh_api_call METHOD ENDPOINT [BODY]
ovh_api_call() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    local full_url="${OVH_API_BASE}${endpoint}"
    local timestamp
    timestamp=$(_ovh_get_timestamp)

    local signature
    signature=$(_ovh_sign "${method}" "${full_url}" "${body}" "${timestamp}")

    local args=(
        -s
        -X "${method}"
        -H "X-Ovh-Application: ${OVH_APPLICATION_KEY}"
        -H "X-Ovh-Consumer: ${OVH_CONSUMER_KEY}"
        -H "X-Ovh-Timestamp: ${timestamp}"
        -H "X-Ovh-Signature: ${signature}"
        -H "Content-Type: application/json"
    )

    if [[ -n "${body}" ]]; then
        args+=(-d "${body}")
    fi

    local response
    response=$(curl "${args[@]}" "${full_url}" 2>&1)
    echo "${response}"
}

# Test OVH API credentials
_test_ovh_credentials() {
    local response
    response=$(ovh_api_call GET "/me")
    if echo "$response" | grep -q '"message"'; then
        return 1
    fi
    return 0
}

# Ensure OVH credentials are available (env vars -> config file -> prompt+save)
ensure_ovh_authenticated() {
    ensure_multi_credentials "OVHcloud" "$HOME/.config/spawn/ovh.json" \
        "https://api.ovh.com/createToken/" _test_ovh_credentials \
        "OVH_APPLICATION_KEY:application_key:Application Key" \
        "OVH_APPLICATION_SECRET:application_secret:Application Secret" \
        "OVH_CONSUMER_KEY:consumer_key:Consumer Key" \
        "OVH_PROJECT_ID:project_id:Project ID"
}

# Check if SSH key is registered with OVH
ovh_check_ssh_key() {
    check_ssh_key_by_fingerprint ovh_api_call "/cloud/project/${OVH_PROJECT_ID}/sshkey" "$1"
}

# Register SSH key with OVH
ovh_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    local body
    body=$(echo "$pub_key" | python3 -c "
import json, sys
pub_key = sys.stdin.read().strip()
body = {
    'name': sys.argv[1],
    'publicKey': pub_key
}
print(json.dumps(body))
" "$key_name")

    local response
    response=$(ovh_api_call POST "/cloud/project/${OVH_PROJECT_ID}/sshkey" "$body")

    if echo "$response" | grep -q '"message"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "Failed to register SSH key: $error_msg"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with OVH
ensure_ssh_key() {
    ensure_ssh_key_with_provider ovh_check_ssh_key ovh_register_ssh_key "OVHcloud"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "OVH_SERVER_NAME" "Enter server name: "
}

# Find OVH image ID for Ubuntu 24.04
_ovh_find_image_id() {
    local region="$1"
    local images_response
    images_response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/image?region=${region}&osType=linux")

    python3 -c "
import json, sys
images = json.loads(sys.stdin.read())
for img in images:
    name = img.get('name', '')
    if 'Ubuntu 24.04' in name or 'ubuntu-24.04' in name.lower():
        print(img['id'])
        sys.exit(0)
# Fallback: any Ubuntu image
for img in images:
    name = img.get('name', '')
    if 'Ubuntu' in name or 'ubuntu' in name:
        print(img['id'])
        sys.exit(0)
print('')
" <<< "${images_response}"
}

# Find OVH flavor ID
_ovh_find_flavor_id() {
    local region="$1"
    local flavor_name="$2"
    local flavors_response
    flavors_response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/flavor?region=${region}")

    python3 -c "
import json, sys
flavors = json.loads(sys.stdin.read())
target = sys.argv[1]
for f in flavors:
    if f.get('name', '') == target:
        print(f['id'])
        sys.exit(0)
print('')
" "$flavor_name" <<< "${flavors_response}"
}

# Get SSH key ID from OVH
_ovh_get_ssh_key_id() {
    local fingerprint="$1"
    local keys_response
    keys_response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/sshkey")

    python3 -c "
import json, sys
keys = json.loads(sys.stdin.read())
fp = sys.argv[1]
for k in keys:
    if fp in k.get('fingerprint', '') or fp in k.get('publicKey', ''):
        print(k['id'])
        sys.exit(0)
# Fallback: return first key
if keys:
    print(keys[0]['id'])
" "$fingerprint" <<< "${keys_response}"
}

# Resolve image ID, flavor ID, and SSH key ID for OVH instance creation
# Outputs three lines: image_id, flavor_id, ssh_key_id
# Usage: _ovh_resolve_resources REGION FLAVOR_NAME
_ovh_resolve_resources() {
    local region="$1"
    local flavor_name="$2"

    local image_id
    image_id=$(_ovh_find_image_id "${region}")
    if [[ -z "${image_id}" ]]; then
        log_error "Failed to find Ubuntu 24.04 image in region ${region}"
        log_error "Try a different OVH_REGION (e.g., GRA11, SBG5, BHS5, WAW1)"
        return 1
    fi
    log_info "Found image: ${image_id}"

    local flavor_id
    flavor_id=$(_ovh_find_flavor_id "${region}" "${flavor_name}")
    if [[ -z "${flavor_id}" ]]; then
        log_error "Failed to find flavor '${flavor_name}' in region ${region}"
        log_error "Try a different OVH_FLAVOR (e.g., d2-2, d2-4, s1-2) or OVH_REGION"
        return 1
    fi
    log_info "Found flavor: ${flavor_id}"

    local pub_path="${HOME}/.ssh/id_ed25519.pub"
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "${pub_path}")
    local ssh_key_id
    ssh_key_id=$(_ovh_get_ssh_key_id "${fingerprint}")

    printf '%s\n%s\n%s\n' "${image_id}" "${flavor_id}" "${ssh_key_id}"
}

# Build JSON request body for OVH instance creation
# Usage: _ovh_build_instance_body NAME FLAVOR_ID IMAGE_ID REGION SSH_KEY_ID
_ovh_build_instance_body() {
    local name="$1" flavor_id="$2" image_id="$3" region="$4" ssh_key_id="$5"
    python3 -c "
import json, sys
name, flavor_id, image_id, region, ssh_key_id = sys.argv[1:6]
body = {
    'name': name,
    'flavorId': flavor_id,
    'imageId': image_id,
    'region': region,
    'monthlyBilling': False
}
if ssh_key_id:
    body['sshKeyId'] = ssh_key_id
print(json.dumps(body))
" "$name" "$flavor_id" "$image_id" "$region" "$ssh_key_id"
}

# Create an OVH Public Cloud instance
create_ovh_instance() {
    local name="$1"
    local flavor="${OVH_FLAVOR:-d2-2}"
    local region="${OVH_REGION:-GRA7}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$flavor" || { log_error "Invalid OVH_FLAVOR"; return 1; }
    validate_region_name "$region" || { log_error "Invalid OVH_REGION"; return 1; }

    log_step "Creating OVHcloud instance '$name' (flavor: $flavor, region: $region)..."

    # Resolve image, flavor, and SSH key IDs
    local resources
    resources=$(_ovh_resolve_resources "${region}" "${flavor}") || return 1
    local image_id flavor_id ssh_key_id
    { read -r image_id; read -r flavor_id; read -r ssh_key_id; } <<< "${resources}"

    local body
    body=$(_ovh_build_instance_body "$name" "$flavor_id" "$image_id" "$region" "$ssh_key_id")

    local response
    response=$(ovh_api_call POST "/cloud/project/${OVH_PROJECT_ID}/instance" "$body")

    # Check for errors
    if echo "$response" | grep -q '"message"'; then
        log_error "Failed to create OVHcloud instance"
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance or payment method required"
        log_error "  - Flavor/region unavailable (try different OVH_FLAVOR or OVH_REGION)"
        log_error "  - Project quota reached"
        log_error ""
        log_error "Check your account at: https://www.ovh.com/manager/public-cloud/"
        return 1
    fi

    # Extract instance ID
    OVH_INSTANCE_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])")
    export OVH_INSTANCE_ID

    log_info "Instance created: ID=$OVH_INSTANCE_ID"
}

# Wait for OVH instance to be ACTIVE and get IP
# OVH IP extraction: prefer public IPv4, fallback to first IPv4
wait_for_ovh_instance() {
    local instance_id="$1"
    local max_attempts="${2:-60}"

    generic_wait_for_instance ovh_api_call \
        "/cloud/project/${OVH_PROJECT_ID}/instance/${instance_id}" \
        "ACTIVE" \
        "d.get('status','')" \
        "next((a['ip'] for a in d.get('ipAddresses',[]) if a.get('version',0)==4 and a.get('type','')=='public'), next((a['ip'] for a in d.get('ipAddresses',[]) if a.get('version',0)==4), ''))" \
        OVH_SERVER_IP "OVHcloud instance" "${max_attempts}"
}

# Destroy an OVH instance
destroy_ovh_instance() {
    local instance_id="$1"

    log_step "Destroying OVHcloud instance $instance_id..."
    local response
    response=$(ovh_api_call DELETE "/cloud/project/${OVH_PROJECT_ID}/instance/${instance_id}")

    if echo "$response" | grep -q '"message"'; then
        log_error "Failed to destroy instance $instance_id"
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_error ""
        log_error "The instance may still be running and incurring charges."
        log_error "Delete it manually at: https://www.ovhcloud.com/manager/"
        return 1
    fi

    log_info "Instance $instance_id destroyed"
}

# OVH uses configurable SSH user (ubuntu for newer images, root for older)
SSH_USER="${OVH_SSH_USER:-ubuntu}"

# SSH operations — delegates to shared helpers
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_ovh() { ssh_run_server "$@"; }
upload_file_ovh() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

# Install base dependencies on the server (since OVH doesn't use cloud-init by default)
install_base_deps() {
    local ip="$1"

    log_step "Installing base dependencies..."

    # Use sudo if not root
    local sudo_prefix=""
    if [[ "${SSH_USER}" != "root" ]]; then
        sudo_prefix="sudo "
    fi

    run_ovh "$ip" "${sudo_prefix}apt-get update -qq && ${sudo_prefix}apt-get install -y -qq curl unzip git zsh build-essential python3 python3-pip nodejs npm > /dev/null 2>&1"

    # Install Bun
    run_ovh "$ip" "curl -fsSL https://bun.sh/install | bash"

    # Install Claude Code
    run_ovh "$ip" "curl -fsSL https://claude.ai/install.sh | bash"

    # Configure PATH
    run_ovh "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc"
    run_ovh "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc"

    log_info "Base dependencies installed"
}

# Inject environment variables using SSH
inject_env_vars_ovh() {
    local server_ip="$1"
    shift
    inject_env_vars_ssh "${server_ip}" "upload_file_ovh ${server_ip}" "run_ovh ${server_ip}" "$@"
}

# List all OVH instances
list_instances() {
    local response
    response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/instance")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if not data:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'FLAVOR':<10}\")
print('-' * 103)
for s in data:
    name = s['name']
    sid = s['id'][:36]
    status = s['status']
    ip = 'N/A'
    for addr in s.get('ipAddresses', []):
        if addr.get('version', 0) == 4:
            ip = addr['ip']
            break
    flavor = s.get('flavor', {}).get('name', 'N/A') if isinstance(s.get('flavor'), dict) else 'N/A'
    print(f'{name:<25} {sid:<40} {status:<12} {ip:<16} {flavor:<10}')
" <<< "$response"
}
