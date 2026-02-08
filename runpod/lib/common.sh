#!/bin/bash
set -eo pipefail
# Common bash functions for RunPod GPU Cloud spawn scripts

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

# Note: Provider-agnostic functions (logging, OAuth, browser) are now in shared/common.sh

# ============================================================
# RunPod Cloud specific functions
# ============================================================

readonly RUNPOD_GRAPHQL_API="https://api.runpod.io/graphql"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timing constants
POD_STATUS_POLL_DELAY=${POD_STATUS_POLL_DELAY:-10}  # Delay between pod status checks
SSH_RETRY_DELAY=${SSH_RETRY_DELAY:-5}  # Delay between SSH connection retry attempts

# RunPod GraphQL API wrapper
runpod_api() {
    local query="${1}"
    local response
    response=$(curl -s -X POST "${RUNPOD_GRAPHQL_API}" \
        -H "Content-Type: application/json" \
        -H "authorization: ${RUNPOD_API_KEY}" \
        -d "{\"query\": \"${query}\"}")
    echo "${response}"
}

# Test RunPod API key
test_runpod_token() {
    local query="query { myself { id } }"
    local response
    response=$(runpod_api "${query}")
    if echo "${response}" | grep -q '"errors"'; then
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('errors',[{}])[0].get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: ${error_msg}"
        log_warn "Remediation steps:"
        log_warn "  1. Verify API key at: https://www.runpod.io/console/user/settings"
        log_warn "  2. Ensure the key has 'GraphQL' permissions"
        log_warn "  3. Check key hasn't expired or been revoked"
        return 1
    fi
    return 0
}

# Ensure RUNPOD_API_KEY is available (env var → config file → prompt+save)
ensure_runpod_token() {
    ensure_api_token_with_provider \
        "RunPod" \
        "RUNPOD_API_KEY" \
        "${HOME}/.config/spawn/runpod.json" \
        "https://www.runpod.io/console/user/settings" \
        "test_runpod_token"
}

# Check if SSH key is registered with RunPod
runpod_check_ssh_key() {
    local fingerprint="${1}"
    local query="query { myself { pubKeys } }"
    local existing_keys
    existing_keys=$(runpod_api "${query}")
    echo "${existing_keys}" | grep -q "${fingerprint}"
}

# Register SSH key with RunPod
runpod_register_ssh_key() {
    local key_name="${1}"
    local pub_path="${2}"
    local pub_key
    pub_key=$(cat "${pub_path}")

    # Escape for GraphQL (replace double quotes and newlines)
    local escaped_key
    escaped_key=$(echo "${pub_key}" | sed 's/"/\\"/g' | tr -d '\n')

    local mutation="mutation { savePublicKey(input: { name: \\\"${key_name}\\\", key: \\\"${escaped_key}\\\" }) }"
    local register_response
    register_response=$(runpod_api "${mutation}")

    if echo "${register_response}" | grep -q '"errors"'; then
        local error_msg
        error_msg=$(echo "${register_response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('errors',[{}])[0].get('message','Unknown error'))" 2>/dev/null || echo "${register_response}")
        log_error "API Error: ${error_msg}"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API key lacks write permissions"
        return 1
    fi

    return 0
}

# Ensure SSH key exists locally and is registered with RunPod
ensure_ssh_key() {
    ensure_ssh_key_with_provider runpod_check_ssh_key runpod_register_ssh_key "RunPod"
}

# Get pod name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "RUNPOD_POD_NAME" "Enter pod name: ") || return 1

    if ! validate_server_name "${server_name}"; then
        return 1
    fi

    echo "${server_name}"
}

# Create a RunPod GPU pod
create_server() {
    local name="${1}"
    local gpu_type="${RUNPOD_GPU_TYPE:-NVIDIA GeForce RTX 4090}"
    local gpu_count="${RUNPOD_GPU_COUNT:-1}"
    local cloud_type="${RUNPOD_CLOUD_TYPE:-ALL}"
    local disk_size="${RUNPOD_DISK_SIZE:-40}"
    local volume_size="${RUNPOD_VOLUME_SIZE:-40}"
    local container_image="${RUNPOD_IMAGE:-runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04}"

    log_warn "Creating RunPod pod '${name}' (GPU: ${gpu_type} x${gpu_count}, disk: ${disk_size}GB)..."

    # Get SSH public key for injection
    local pub_key
    pub_key=$(cat "${HOME}/.ssh/id_ed25519.pub")
    local escaped_pub_key
    escaped_pub_key=$(echo "${pub_key}" | sed 's/"/\\"/g' | tr -d '\n')

    # Escape the mutation query for GraphQL
    local mutation
    mutation=$(cat <<EOF
mutation {
  podFindAndDeployOnDemand(
    input: {
      cloudType: ${cloud_type}
      gpuCount: ${gpu_count}
      volumeInGb: ${volume_size}
      containerDiskInGb: ${disk_size}
      minVcpuCount: 2
      minMemoryInGb: 15
      gpuTypeId: \\\"${gpu_type}\\\"
      name: \\\"${name}\\\"
      imageName: \\\"${container_image}\\\"
      ports: \\\"22/tcp,8888/http\\\"
      volumeMountPath: \\\"/workspace\\\"
      env: [
        { key: \\\"SSH_PUBLIC_KEY\\\", value: \\\"${escaped_pub_key}\\\" }
        { key: \\\"PUBLIC_KEY\\\", value: \\\"${escaped_pub_key}\\\" }
      ]
    }
  ) {
    id
    imageName
    machine { podHostId }
    runtime { ports { ip publicPort } }
  }
}
EOF
)

    local response
    response=$(runpod_api "${mutation}")

    # Check for errors
    if echo "${response}" | grep -q '"errors"'; then
        log_error "Failed to create RunPod pod"
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('errors',[{}])[0].get('message','Unknown error'))" 2>/dev/null || echo "${response}")
        log_error "API Error: ${error_msg}"
        log_warn "Common issues:"
        log_warn "  - Insufficient credits or payment method required"
        log_warn "  - GPU type unavailable (try different RUNPOD_GPU_TYPE)"
        log_warn "  - Resource limits reached"
        log_warn "Remediation: Check https://www.runpod.io/console/pods"
        return 1
    fi

    # Extract pod ID and wait for runtime info
    RUNPOD_POD_ID=$(echo "${response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['podFindAndDeployOnDemand']['id'])")
    export RUNPOD_POD_ID
    log_info "Pod created: ID=${RUNPOD_POD_ID}"

    # Wait for pod to become active and get SSH connection info
    log_warn "Waiting for pod to become active..."
    local max_attempts=60 attempt=1
    while [[ ${attempt} -le ${max_attempts} ]]; do
        local query="query { pod(input: { podId: \\\"${RUNPOD_POD_ID}\\\" }) { id desiredStatus runtime { ports { ip publicPort } } } }"
        local status_response
        status_response=$(runpod_api "${query}")

        local status
        status=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['pod'].get('desiredStatus',''))" 2>/dev/null)

        if [[ "${status}" == "RUNNING" ]]; then
            # Extract SSH connection info (port 22)
            RUNPOD_POD_IP=$(echo "${status_response}" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ports = data['data']['pod']['runtime']['ports']
for port in ports:
    if port.get('publicPort') == 22:
        print(port['ip'])
        break
" 2>/dev/null)
            RUNPOD_SSH_PORT=$(echo "${status_response}" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ports = data['data']['pod']['runtime']['ports']
for port in ports:
    if port.get('publicPort') == 22:
        print(port.get('ip', '').split(':')[-1] if ':' in port.get('ip', '') else '22')
        break
" 2>/dev/null)
            export RUNPOD_POD_IP RUNPOD_SSH_PORT
            log_info "Pod active: IP=${RUNPOD_POD_IP}, SSH port=${RUNPOD_SSH_PORT}"
            return 0
        fi
        log_warn "Pod status: ${status} (${attempt}/${max_attempts})"
        sleep "${POD_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done
    log_error "Pod did not become active in time"
    return 1
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="${1}"
    local ssh_port="${2:-22}"
    local max_attempts=${3:-30}
    local attempt=1
    log_warn "Waiting for SSH connectivity to ${ip}:${ssh_port}..."
    while [[ ${attempt} -le ${max_attempts} ]]; do
        # shellcheck disable=SC2086
        if ssh ${SSH_OPTS} -o ConnectTimeout=5 -p "${ssh_port}" "root@${ip}" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"
            return 0
        fi
        log_warn "Waiting for SSH... (${attempt}/${max_attempts})"
        sleep "${SSH_RETRY_DELAY}"
        attempt=$((attempt + 1))
    done
    log_error "Pod failed to respond via SSH after ${max_attempts} attempts"
    return 1
}

# Install base tools on RunPod
wait_for_cloud_init() {
    local ip="${1}"
    local ssh_port="${2:-22}"
    # RunPod pods come with most tools, just install missing ones
    log_warn "Installing base tools..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "apt-get update -y && apt-get install -y curl unzip git zsh" >/dev/null 2>&1

    # Install Bun
    log_warn "Installing Bun..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1

    # Install Claude Code
    log_warn "Installing Claude Code..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1

    # Configure PATH
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "echo 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc && echo 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc" >/dev/null 2>&1

    log_info "Base tools installed"
}

# Run a command on the pod
run_server() {
    local ip="${1}"
    local cmd="${2}"
    local ssh_port="${RUNPOD_SSH_PORT:-22}"
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "${cmd}"
}

# Upload a file to the pod
upload_file() {
    local ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    local ssh_port="${RUNPOD_SSH_PORT:-22}"
    # shellcheck disable=SC2086
    scp ${SSH_OPTS} -P "${ssh_port}" "${local_path}" "root@${ip}:${remote_path}"
}

# Start an interactive SSH session
interactive_session() {
    local ip="${1}"
    local cmd="${2}"
    local ssh_port="${RUNPOD_SSH_PORT:-22}"
    # shellcheck disable=SC2086
    ssh -t ${SSH_OPTS} -p "${ssh_port}" "root@${ip}" "${cmd}"
}

# Destroy a RunPod pod
destroy_server() {
    local pod_id="${1}"
    log_warn "Terminating pod ${pod_id}..."
    local mutation="mutation { podTerminate(input: { podId: \\\"${pod_id}\\\" }) }"
    runpod_api "${mutation}"
    log_info "Pod ${pod_id} terminated"
}

# List all RunPod pods
list_servers() {
    local query="query { myself { pods { id name desiredStatus runtime { ports { ip publicPort } } } } }"
    local response
    response=$(runpod_api "${query}")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
pods = data.get('data', {}).get('myself', {}).get('pods', [])
if not pods:
    print('No pods found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<25} {'STATUS':<12} {'SSH':<30}\")
print('-' * 92)
for p in pods:
    name = p.get('name', 'N/A')
    pid = p['id']
    status = p.get('desiredStatus', 'N/A')
    ssh_info = 'N/A'
    if p.get('runtime') and p['runtime'].get('ports'):
        for port in p['runtime']['ports']:
            if port.get('publicPort') == 22:
                ssh_info = port.get('ip', 'N/A')
                break
    print(f'{name:<25} {pid:<25} {status:<12} {ssh_info:<30}')
" <<< "${response}"
}
