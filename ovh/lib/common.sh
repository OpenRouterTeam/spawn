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
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# OVHcloud specific functions
# ============================================================

readonly OVH_API_BASE="https://eu.api.ovh.com/1.0"

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
test_ovh_token() {
    local response
    response=$(ovh_api_call GET "/me")
    if echo "$response" | grep -q '"message"'; then
        local error_msg
        error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your credentials at: https://api.ovh.com/createToken/"
        log_error "  2. Ensure Application Key, Application Secret, and Consumer Key are correct"
        log_error "  3. Check the Consumer Key has the required permissions"
        return 1
    fi
    return 0
}

# Try to load OVH credentials from config file
# Returns 0 if all 4 credentials loaded, 1 otherwise
_load_ovh_config() {
    local config_file="$1"
    [[ -f "${config_file}" ]] || return 1

    local creds
    creds=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
for k in ('application_key','application_secret','consumer_key','project_id'):
    print(d.get(k, ''))
" "${config_file}" 2>/dev/null) || return 1

    [[ -n "${creds}" ]] || return 1

    local saved_ak saved_as saved_ck saved_pid
    { read -r saved_ak; read -r saved_as; read -r saved_ck; read -r saved_pid; } <<< "${creds}"
    if [[ -n "${saved_ak}" && -n "${saved_as}" && -n "${saved_ck}" && -n "${saved_pid}" ]]; then
        export OVH_APPLICATION_KEY="${saved_ak}"
        export OVH_APPLICATION_SECRET="${saved_as}"
        export OVH_CONSUMER_KEY="${saved_ck}"
        export OVH_PROJECT_ID="${saved_pid}"
        log_info "Using OVHcloud credentials from ${config_file}"
        return 0
    fi
    return 1
}

# Save OVH credentials to config file
_save_ovh_config() {
    local config_file="$1"
    local app_key="$2"
    local app_secret="$3"
    local consumer_key="$4"
    local project_id="$5"

    local config_dir
    config_dir=$(dirname "${config_file}")
    mkdir -p "${config_dir}"
    printf '{\n  "application_key": %s,\n  "application_secret": %s,\n  "consumer_key": %s,\n  "project_id": %s\n}\n' \
        "$(json_escape "${app_key}")" "$(json_escape "${app_secret}")" \
        "$(json_escape "${consumer_key}")" "$(json_escape "${project_id}")" > "${config_file}"
    chmod 600 "${config_file}"
    log_info "OVHcloud credentials saved to ${config_file}"
}

# Ensure OVH credentials are available (env vars -> config file -> prompt+save)
ensure_ovh_authenticated() {
    check_python_available || return 1

    local config_file="$HOME/.config/spawn/ovh.json"

    # Try environment variables first
    if [[ -n "${OVH_APPLICATION_KEY:-}" && -n "${OVH_APPLICATION_SECRET:-}" && -n "${OVH_CONSUMER_KEY:-}" && -n "${OVH_PROJECT_ID:-}" ]]; then
        log_info "Using OVHcloud credentials from environment"
        return 0
    fi

    # Try config file
    if _load_ovh_config "${config_file}"; then
        return 0
    fi

    # Prompt for credentials
    echo ""
    log_warn "OVHcloud API Credentials Required"
    log_warn "Create credentials at: https://api.ovh.com/createToken/"
    log_warn ""
    log_warn "Required permissions:"
    log_warn "  GET    /cloud/project/*"
    log_warn "  POST   /cloud/project/*"
    log_warn "  DELETE /cloud/project/*"
    log_warn "  GET    /me"
    echo ""

    local app_key app_secret consumer_key project_id

    app_key=$(validated_read "Enter OVH Application Key: " validate_api_token) || return 1
    app_secret=$(validated_read "Enter OVH Application Secret: " validate_api_token) || return 1
    consumer_key=$(validated_read "Enter OVH Consumer Key: " validate_api_token) || return 1

    echo ""
    log_warn "Your OVH Public Cloud Project ID is required."
    log_warn "Find it at: https://www.ovh.com/manager/public-cloud/ (select project -> Project ID)"
    echo ""
    project_id=$(validated_read "Enter OVH Project ID: " validate_api_token) || return 1

    export OVH_APPLICATION_KEY="${app_key}"
    export OVH_APPLICATION_SECRET="${app_secret}"
    export OVH_CONSUMER_KEY="${consumer_key}"
    export OVH_PROJECT_ID="${project_id}"

    # Validate credentials
    if ! test_ovh_token; then
        unset OVH_APPLICATION_KEY OVH_APPLICATION_SECRET OVH_CONSUMER_KEY OVH_PROJECT_ID
        return 1
    fi

    _save_ovh_config "${config_file}" "${app_key}" "${app_secret}" "${consumer_key}" "${project_id}"
    return 0
}

# Check if SSH key is registered with OVH
ovh_check_ssh_key() {
    local fingerprint="$1"
    local existing_keys
    existing_keys=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/sshkey")
    echo "$existing_keys" | grep -q "$fingerprint"
}

# Register SSH key with OVH
ovh_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")

    local body
    body=$(python3 -c "
import json
body = {
    'name': '${key_name}',
    'publicKey': json.loads(${json_pub_key})
}
print(json.dumps(body))
")

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
    local server_name
    server_name=$(get_resource_name "OVH_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
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
target = '${flavor_name}'
for f in flavors:
    if f.get('name', '') == target:
        print(f['id'])
        sys.exit(0)
print('')
" <<< "${flavors_response}"
}

# Get SSH key ID from OVH
_ovh_get_ssh_key_id() {
    local fingerprint="$1"
    local keys_response
    keys_response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/sshkey")

    python3 -c "
import json, sys
keys = json.loads(sys.stdin.read())
fp = '${fingerprint}'
for k in keys:
    if fp in k.get('fingerprint', '') or fp in k.get('publicKey', ''):
        print(k['id'])
        sys.exit(0)
# Fallback: return first key
if keys:
    print(keys[0]['id'])
" <<< "${keys_response}"
}

# Create an OVH Public Cloud instance
create_ovh_instance() {
    local name="$1"
    local flavor="${OVH_FLAVOR:-d2-2}"
    local region="${OVH_REGION:-GRA7}"

    # Validate env var inputs to prevent injection into Python code
    validate_resource_name "$flavor" || { log_error "Invalid OVH_FLAVOR"; return 1; }
    validate_region_name "$region" || { log_error "Invalid OVH_REGION"; return 1; }

    log_warn "Creating OVHcloud instance '$name' (flavor: $flavor, region: $region)..."

    # Find image ID
    local image_id
    image_id=$(_ovh_find_image_id "${region}")
    if [[ -z "${image_id}" ]]; then
        log_error "Failed to find Ubuntu 24.04 image in region ${region}"
        return 1
    fi
    log_info "Found image: ${image_id}"

    # Find flavor ID
    local flavor_id
    flavor_id=$(_ovh_find_flavor_id "${region}" "${flavor}")
    if [[ -z "${flavor_id}" ]]; then
        log_error "Failed to find flavor '${flavor}' in region ${region}"
        return 1
    fi
    log_info "Found flavor: ${flavor_id}"

    # Get SSH key ID
    local pub_path="${HOME}/.ssh/id_ed25519.pub"
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "${pub_path}")
    local ssh_key_id
    ssh_key_id=$(_ovh_get_ssh_key_id "${fingerprint}")

    # Build request body
    local body
    body=$(python3 -c "
import json
body = {
    'name': '${name}',
    'flavorId': '${flavor_id}',
    'imageId': '${image_id}',
    'region': '${region}',
    'monthlyBilling': False
}
ssh_key_id = '${ssh_key_id}'
if ssh_key_id:
    body['sshKeyId'] = ssh_key_id
print(json.dumps(body))
")

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
wait_for_ovh_instance() {
    local instance_id="$1"
    local max_attempts="${2:-60}"
    local attempt=1
    local interval=5
    local max_interval=15

    log_warn "Waiting for OVHcloud instance to become active..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        local response
        response=$(ovh_api_call GET "/cloud/project/${OVH_PROJECT_ID}/instance/${instance_id}")

        local status
        status=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('status',''))" 2>/dev/null || echo "")

        if [[ "${status}" == "ACTIVE" ]]; then
            OVH_SERVER_IP=$(echo "$response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for addr in data.get('ipAddresses', []):
    if addr.get('version', 0) == 4 and addr.get('type', '') == 'public':
        print(addr['ip'])
        sys.exit(0)
# Fallback: first IPv4
for addr in data.get('ipAddresses', []):
    if addr.get('version', 0) == 4:
        print(addr['ip'])
        sys.exit(0)
print('')
")
            export OVH_SERVER_IP
            if [[ -n "${OVH_SERVER_IP}" ]]; then
                log_info "Instance active: IP=$OVH_SERVER_IP"
                return 0
            fi
        fi

        local jitter
        jitter=$(calculate_retry_backoff "${interval}" "${max_interval}")
        log_warn "Instance status: ${status:-unknown} (attempt ${attempt}/${max_attempts}, retry in ${jitter}s)"
        sleep "${jitter}"

        interval=$((interval * 2))
        if [[ "${interval}" -gt "${max_interval}" ]]; then
            interval="${max_interval}"
        fi
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become active after ${max_attempts} attempts"
    return 1
}

# Destroy an OVH instance
destroy_ovh_instance() {
    local instance_id="$1"

    log_warn "Destroying OVHcloud instance $instance_id..."
    local response
    response=$(ovh_api_call DELETE "/cloud/project/${OVH_PROJECT_ID}/instance/${instance_id}")

    if echo "$response" | grep -q '"message"'; then
        log_error "Failed to destroy instance: $response"
        return 1
    fi

    log_info "Instance $instance_id destroyed"
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # OVH Ubuntu instances use 'ubuntu' user by default for newer images,
    # but some use 'root'. We use the configured user.
    local user="${OVH_SSH_USER:-ubuntu}"
    # shellcheck disable=SC2154
    generic_ssh_wait "${user}" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

# Run a command on the server
run_ovh() {
    local ip="$1"
    local cmd="$2"
    local user="${OVH_SSH_USER:-ubuntu}"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "${user}@$ip" "$cmd"
}

# Upload a file to the server
upload_file_ovh() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    local user="${OVH_SSH_USER:-ubuntu}"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "${user}@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    local user="${OVH_SSH_USER:-ubuntu}"
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "${user}@$ip" "$cmd"
}

# Install base dependencies on the server (since OVH doesn't use cloud-init by default)
install_base_deps() {
    local ip="$1"
    local user="${OVH_SSH_USER:-ubuntu}"

    log_warn "Installing base dependencies..."

    # Use sudo if not root
    local sudo_prefix=""
    if [[ "${user}" != "root" ]]; then
        sudo_prefix="sudo "
    fi

    run_ovh "$ip" "${sudo_prefix}apt-get update -qq && ${sudo_prefix}apt-get install -y -qq curl unzip git zsh build-essential python3 python3-pip nodejs npm > /dev/null 2>&1"

    # Install Bun
    run_ovh "$ip" "curl -fsSL https://bun.sh/install | bash"

    # Install Claude Code
    run_ovh "$ip" "curl -fsSL https://claude.ai/install.sh | bash"

    # Configure PATH
    run_ovh "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc"
    run_ovh "$ip" "printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc"

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
