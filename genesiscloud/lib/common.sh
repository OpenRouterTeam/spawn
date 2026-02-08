#!/bin/bash
# Common bash functions for Genesis Cloud spawn scripts
# Uses Genesis Cloud REST API — https://developers.genesiscloud.com/

# Bash safety flags
set -eo pipefail

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../../shared/common.sh" ]]; then
    source "${SCRIPT_DIR}/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# Genesis Cloud specific functions
# ============================================================

GENESIS_API_BASE="https://api.genesiscloud.com"
# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-10}  # Delay between instance status checks
SSH_RETRY_DELAY=${SSH_RETRY_DELAY:-5}  # Delay between SSH connection retry attempts

# Genesis Cloud API wrapper
# Usage: genesis_api METHOD ENDPOINT [BODY]
genesis_api() {
    local method="${1}" endpoint="${2}" body="${3}"
    local args=(-s -X "${method}" -H "Authorization: Bearer ${GENESIS_API_KEY}" -H "Content-Type: application/json")
    if [[ -n "${body}" ]]; then args+=(-d "${body}"); fi
    curl "${args[@]}" "${GENESIS_API_BASE}${endpoint}"
}

# Test Genesis Cloud API key validity
test_genesis_token() {
    local test_response
    test_response=$(genesis_api GET "/compute/v1/instances")
    if echo "${test_response}" | grep -q '"error"'; then
        log_error "Invalid API key"
        return 1
    fi
    return 0
}

# Ensure GENESIS_API_KEY is available (env var -> config file -> prompt+save)
ensure_genesis_token() {
    ensure_api_token_with_provider \
        "Genesis Cloud" \
        "GENESIS_API_KEY" \
        "${HOME}/.config/spawn/genesiscloud.json" \
        "https://developers.genesiscloud.com/docs/getting-started/create-api-token/" \
        "test_genesis_token"
}

# Check if SSH key is registered with Genesis Cloud
genesis_check_ssh_key() {
    local fingerprint="${1}"
    local existing_keys
    existing_keys=$(genesis_api GET "/compute/v1/ssh-keys")
    echo "${existing_keys}" | grep -q "${fingerprint}"
}

# Register SSH key with Genesis Cloud
genesis_register_ssh_key() {
    local key_name="${1}"
    local pub_path="${2}"
    local pub_key
    pub_key=$(cat "${pub_path}")
    local json_pub_key
    json_pub_key=$(json_escape "${pub_key}")
    local register_body="{\"name\":\"${key_name}\",\"public_key\":${json_pub_key}}"
    local register_response
    register_response=$(genesis_api POST "/compute/v1/ssh-keys" "${register_body}")

    if echo "${register_response}" | grep -q '"id"'; then
        return 0
    else
        log_error "Failed to register SSH key: ${register_response}"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider genesis_check_ssh_key genesis_register_ssh_key "Genesis Cloud"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "GENESIS_SERVER_NAME" "Enter instance name: ") || return 1

    if ! validate_server_name "${server_name}"; then
        return 1
    fi

    echo "${server_name}"
}

# Get list of available images from Genesis Cloud
get_genesis_image_id() {
    local image_name="${1:-Ubuntu 24.04}"

    log_warn "Fetching available images..."
    local images_response
    images_response=$(genesis_api GET "/compute/v1/images")

    local image_id
    image_id=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
images = data.get('images', [])
for img in images:
    if '${image_name}' in img.get('name', ''):
        print(img['id'])
        sys.exit(0)
print('')
" <<< "${images_response}")

    echo "${image_id}"
}

# Get SSH key IDs for instance creation
get_genesis_ssh_key_ids() {
    local ssh_keys_response
    ssh_keys_response=$(genesis_api GET "/compute/v1/ssh-keys")

    local ssh_key_ids
    ssh_key_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keys = data.get('ssh_keys', [])
ids = [k['id'] for k in keys]
print(json.dumps(ids))
" <<< "${ssh_keys_response}")

    echo "${ssh_key_ids}"
}

create_server() {
    local name="${1}"
    local instance_type="${GENESIS_INSTANCE_TYPE:-vcpu-4_memory-12g_nvidia-rtx-3080-1}"
    local region="${GENESIS_REGION:-ARC-IS-HAF-1}"
    local image="${GENESIS_IMAGE:-Ubuntu 24.04}"

    log_warn "Creating Genesis Cloud instance '${name}' (type: ${instance_type}, region: ${region})..."

    # Get image ID
    local image_id
    image_id=$(get_genesis_image_id "${image}")
    if [[ -z "${image_id}" ]]; then
        log_error "Failed to find image: ${image}"
        log_warn "Available images can be found at: https://developers.genesiscloud.com/docs/compute/instances/create-instance/"
        return 1
    fi

    # Get SSH key IDs
    local ssh_key_ids
    ssh_key_ids=$(get_genesis_ssh_key_ids)

    local body
    body=$(python3 -c "
import json
body = {
    'name': '${name}',
    'hostname': '${name}',
    'type': '${instance_type}',
    'image': '${image_id}',
    'region': '${region}',
    'ssh_keys': ${ssh_key_ids}
}
print(json.dumps(body))
")

    local response
    response=$(genesis_api POST "/compute/v1/instances" "${body}")

    if echo "${response}" | grep -q '"id"'; then
        GENESIS_SERVER_ID=$(echo "${response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['id'])")
        export GENESIS_SERVER_ID
        log_info "Instance created: ID=${GENESIS_SERVER_ID}"
    else
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read())
if 'error' in d:
    print(d['error'].get('message', str(d['error'])))
else:
    print(d)
" 2>/dev/null || echo "${response}")
        log_error "Failed to create instance: ${error_msg}"
        return 1
    fi

    # Wait for instance to become active and get IP
    log_warn "Waiting for instance to become active..."
    local max_attempts=60 attempt=1
    while [[ ${attempt} -le ${max_attempts} ]]; do
        local status_response
        status_response=$(genesis_api GET "/compute/v1/instances/${GENESIS_SERVER_ID}")
        local status
        status=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['status'])" 2>/dev/null)

        if [[ "${status}" == "active" ]]; then
            GENESIS_SERVER_IP=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['public_ip'])")
            export GENESIS_SERVER_IP
            log_info "Instance active: IP=${GENESIS_SERVER_IP}"
            return 0
        fi
        log_warn "Instance status: ${status} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"; attempt=$((attempt + 1))
    done
    log_error "Instance did not become active in time"; return 1
}

verify_server_connectivity() {
    local ip="${1}" max_attempts=${2:-30} attempt=1
    log_warn "Waiting for SSH connectivity to ${ip}..."
    while [[ ${attempt} -le ${max_attempts} ]]; do
        # SSH_OPTS is defined in shared/common.sh
        # shellcheck disable=SC2154,SC2086
        if ssh ${SSH_OPTS} -o ConnectTimeout=5 "root@${ip}" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"; return 0
        fi
        log_warn "Waiting for SSH... (${attempt}/${max_attempts})"; sleep "${SSH_RETRY_DELAY}"; attempt=$((attempt + 1))
    done
    log_error "Server failed to respond via SSH after ${max_attempts} attempts"; return 1
}

wait_for_cloud_init() {
    local ip="${1}"
    # Genesis Cloud instances come with cloud-init, wait for it to complete
    log_warn "Waiting for cloud-init to complete..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "cloud-init status --wait" >/dev/null 2>&1 || true

    # Install base tools
    log_warn "Installing base tools..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "apt-get update -y && apt-get install -y curl unzip git zsh" >/dev/null 2>&1

    # Install Bun
    log_warn "Installing Bun..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1

    # Install Claude Code
    log_warn "Installing Claude Code..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1

    # Configure PATH
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc && printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc" >/dev/null 2>&1

    log_info "Base tools installed"
}

# Genesis Cloud uses 'root' user
# shellcheck disable=SC2086
run_server() { local ip="${1}" cmd="${2}"; ssh ${SSH_OPTS} "root@${ip}" "${cmd}"; }
# shellcheck disable=SC2086
upload_file() { local ip="${1}" local_path="${2}" remote_path="${3}"; scp ${SSH_OPTS} "${local_path}" "root@${ip}:${remote_path}"; }
# shellcheck disable=SC2086
interactive_session() { local ip="${1}" cmd="${2}"; ssh -t ${SSH_OPTS} "root@${ip}" "${cmd}"; }

destroy_server() {
    local server_id="${1}"
    log_warn "Terminating instance ${server_id}..."
    genesis_api DELETE "/compute/v1/instances/${server_id}" >/dev/null
    log_info "Instance ${server_id} terminated"
}

list_servers() {
    local response
    response=$(genesis_api GET "/compute/v1/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('instances', [])
if not instances: print('No instances found'); sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'TYPE':<30}\")
print('-' * 123)
for i in instances:
    name = i.get('name','N/A'); iid = i['id']; status = i['status']
    ip = i.get('public_ip', 'N/A'); itype = i.get('type','N/A')
    print(f'{name:<25} {iid:<40} {status:<12} {ip:<16} {itype:<30}')
" <<< "${response}"
}
