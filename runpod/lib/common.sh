#!/bin/bash
# Common bash functions for RunPod spawn scripts
# Uses RunPod GraphQL API — https://docs.runpod.io/

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
# RunPod specific functions
# ============================================================

RUNPOD_GRAPHQL_URL="https://api.runpod.io/graphql"
# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-10}  # Delay between instance status checks
SSH_RETRY_DELAY=${SSH_RETRY_DELAY:-5}  # Delay between SSH connection retry attempts

# RunPod GraphQL API wrapper
# Usage: runpod_api QUERY
runpod_api() {
    local query="${1}"

    # Pass query safely via stdin to avoid triple-quote injection
    local body
    body=$(python3 -c "
import json, sys
q = sys.stdin.read().strip()
print(json.dumps({'query': q}))
" <<< "${query}")

    curl -s -X POST \
        -H "Content-Type: application/json" \
        "${RUNPOD_GRAPHQL_URL}?api_key=${RUNPOD_API_KEY}" \
        -d "${body}"
}

test_runpod_token() {
    local response
    response=$(runpod_api "query { myself { id } }")
    if echo "${response}" | grep -q '"errors"'; then
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('errors',[{}])[0].get('message','Unknown error'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: ${error_msg}"
        log_warn "Remediation steps:"
        log_warn "  1. Verify API key at: https://www.runpod.io/console/user/settings"
        log_warn "  2. Ensure the key has read/write permissions"
        log_warn "  3. Check key hasn't been revoked"
        return 1
    fi
    return 0
}

# Ensure RUNPOD_API_KEY is available (env var -> config file -> prompt+save)
ensure_runpod_token() {
    ensure_api_token_with_provider \
        "RunPod" \
        "RUNPOD_API_KEY" \
        "${HOME}/.config/spawn/runpod.json" \
        "https://www.runpod.io/console/user/settings" \
        "test_runpod_token"
}

# RunPod manages SSH keys at the account level via the web console.
# Users must add their SSH public key at https://www.runpod.io/console/user/settings
# The key is automatically injected into all new pods.
ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"
    generate_ssh_key_if_missing "${key_path}"

    log_warn "RunPod requires SSH keys to be added via the web console."
    log_warn "Ensure your public key is added at: https://www.runpod.io/console/user/settings"
    log_warn ""
    log_warn "Your public key:"
    cat "${key_path}.pub" >&2
    echo "" >&2
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "RUNPOD_SERVER_NAME" "Enter pod name: ") || return 1

    if ! validate_server_name "${server_name}"; then
        return 1
    fi

    echo "${server_name}"
}

create_server() {
    local name="${1}"
    local gpu_type="${RUNPOD_GPU_TYPE:-NVIDIA RTX A4000}"
    local gpu_count="${RUNPOD_GPU_COUNT:-1}"
    local image="${RUNPOD_IMAGE:-runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04}"
    local volume_gb="${RUNPOD_VOLUME_GB:-50}"
    local container_disk_gb="${RUNPOD_CONTAINER_DISK_GB:-20}"
    local cloud_type="${RUNPOD_CLOUD_TYPE:-ALL}"

    # Validate numeric env vars to prevent injection into GraphQL query
    if [[ ! "${gpu_count}" =~ ^[0-9]+$ ]]; then log_error "Invalid RUNPOD_GPU_COUNT: must be numeric"; return 1; fi
    if [[ ! "${volume_gb}" =~ ^[0-9]+$ ]]; then log_error "Invalid RUNPOD_VOLUME_GB: must be numeric"; return 1; fi
    if [[ ! "${container_disk_gb}" =~ ^[0-9]+$ ]]; then log_error "Invalid RUNPOD_CONTAINER_DISK_GB: must be numeric"; return 1; fi
    if [[ ! "${cloud_type}" =~ ^[A-Z]+$ ]]; then log_error "Invalid RUNPOD_CLOUD_TYPE: must be uppercase letters only"; return 1; fi
    # Block injection chars in string values (quotes, backslashes)
    if [[ "${gpu_type}" =~ [\"\`\$\\] ]]; then log_error "Invalid RUNPOD_GPU_TYPE: contains unsafe characters"; return 1; fi
    if [[ "${image}" =~ [\"\`\$\\] ]]; then log_error "Invalid RUNPOD_IMAGE: contains unsafe characters"; return 1; fi

    log_warn "Creating RunPod pod '${name}' (GPU: ${gpu_type}, image: ${image})..."

    local query='mutation { podFindAndDeployOnDemand(input: { name: "'"${name}"'", imageName: "'"${image}"'", gpuTypeId: "'"${gpu_type}"'", cloudType: '"${cloud_type}"', gpuCount: '"${gpu_count}"', volumeInGb: '"${volume_gb}"', containerDiskInGb: '"${container_disk_gb}"', ports: "22/tcp", volumeMountPath: "/workspace", dockerArgs: "" }) { id imageName machineId } }'

    local response
    response=$(runpod_api "${query}")

    if echo "${response}" | grep -q '"errors"'; then
        log_error "Failed to create RunPod pod"
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('errors',[{}])[0].get('message','Unknown error'))" 2>/dev/null || echo "${response}")
        log_error "API Error: ${error_msg}"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - GPU type unavailable (try different RUNPOD_GPU_TYPE)"
        log_warn "  - GPU count unavailable"
        log_warn "Remediation: Check https://www.runpod.io/console/pods"
        return 1
    fi

    RUNPOD_POD_ID=$(echo "${response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['podFindAndDeployOnDemand']['id'])")
    export RUNPOD_POD_ID
    log_info "Pod created: ID=${RUNPOD_POD_ID}"

    # Wait for pod to become ready and get SSH connection info
    log_warn "Waiting for pod to become ready..."
    local max_attempts=60
    local attempt=1
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        local status_query='query { pod(input: { podId: "'"${RUNPOD_POD_ID}"'" }) { id name desiredStatus runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } } } }'
        local status_response
        status_response=$(runpod_api "${status_query}")

        local runtime
        runtime=$(echo "${status_response}" | python3 -c "import json,sys; r=json.loads(sys.stdin.read())['data']['pod']['runtime']; print('running' if r else 'pending')" 2>/dev/null || echo "pending")

        if [[ "${runtime}" == "running" ]]; then
            # Extract SSH connection info from ports
            local ssh_info
            ssh_info=$(echo "${status_response}" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ports = data['data']['pod']['runtime']['ports']
for p in (ports or []):
    if p['privatePort'] == 22 and p['type'] == 'tcp':
        print(p['ip'] + ':' + str(p['publicPort']))
        sys.exit(0)
# No direct TCP port found, fall back to proxy SSH
print('proxy')
" 2>/dev/null || echo "proxy")

            if [[ "${ssh_info}" == "proxy" ]]; then
                # Use RunPod SSH proxy
                RUNPOD_SSH_HOST="ssh.runpod.io"
                RUNPOD_SSH_PORT="22"
                RUNPOD_SSH_USER="${RUNPOD_POD_ID}"
                export RUNPOD_SSH_HOST RUNPOD_SSH_PORT RUNPOD_SSH_USER
                log_info "Pod ready (using SSH proxy: ${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST})"
            else
                RUNPOD_SSH_HOST=$(echo "${ssh_info}" | cut -d: -f1)
                RUNPOD_SSH_PORT=$(echo "${ssh_info}" | cut -d: -f2)
                RUNPOD_SSH_USER="root"
                export RUNPOD_SSH_HOST RUNPOD_SSH_PORT RUNPOD_SSH_USER
                log_info "Pod ready: SSH at ${RUNPOD_SSH_HOST}:${RUNPOD_SSH_PORT}"
            fi
            return 0
        fi

        local desired_status
        desired_status=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['pod']['desiredStatus'])" 2>/dev/null || echo "UNKNOWN")
        log_warn "Pod status: ${desired_status}/${runtime} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Pod did not become ready in time"
    return 1
}

# Build SSH options string for RunPod (may use non-standard port)
_runpod_ssh_opts() {
    echo "${SSH_OPTS} -o ConnectTimeout=10 -p ${RUNPOD_SSH_PORT}"
}

verify_server_connectivity() {
    local max_attempts=${1:-30}
    local attempt=1
    local ssh_target="${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST}"

    log_warn "Waiting for SSH connectivity to ${ssh_target}:${RUNPOD_SSH_PORT}..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        # shellcheck disable=SC2086
        if ssh $(_runpod_ssh_opts) "${ssh_target}" "echo ok" >/dev/null 2>&1; then
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

# Install base tools (RunPod pods are Docker containers, no cloud-init)
install_base_tools() {
    local ssh_target="${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST}"

    log_warn "Installing base tools..."
    # shellcheck disable=SC2086
    ssh $(_runpod_ssh_opts) "${ssh_target}" "apt-get update -y && apt-get install -y curl unzip git zsh npm" >/dev/null 2>&1 || true

    # Install Bun
    log_warn "Installing Bun..."
    # shellcheck disable=SC2086
    ssh $(_runpod_ssh_opts) "${ssh_target}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true

    # Install Claude Code
    log_warn "Installing Claude Code..."
    # shellcheck disable=SC2086
    ssh $(_runpod_ssh_opts) "${ssh_target}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true

    # Configure PATH in .bashrc and .zshrc
    # shellcheck disable=SC2086
    ssh $(_runpod_ssh_opts) "${ssh_target}" "grep -q '.bun/bin' ~/.bashrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc; grep -q '.bun/bin' ~/.zshrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc" >/dev/null 2>&1 || true

    log_info "Base tools installed"
}

# RunPod uses root user (or pod ID for proxy SSH)
# These functions follow the IP-first arg pattern for compatibility with inject_env_vars_ssh
# The "ip" arg is ignored since RunPod uses RUNPOD_SSH_USER@RUNPOD_SSH_HOST
# shellcheck disable=SC2086
run_server() {
    local _ip="${1}"
    local cmd="${2}"
    ssh $(_runpod_ssh_opts) "${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST}" "${cmd}"
}

# shellcheck disable=SC2086
upload_file() {
    local _ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    scp $(_runpod_ssh_opts) "${local_path}" "${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST}:${remote_path}"
}

# shellcheck disable=SC2086
interactive_session() {
    local _ip="${1}"
    local cmd="${2}"
    ssh -t $(_runpod_ssh_opts) "${RUNPOD_SSH_USER}@${RUNPOD_SSH_HOST}" "${cmd}"
}

destroy_server() {
    local pod_id="${1}"
    log_warn "Terminating pod ${pod_id}..."
    local query='mutation { podTerminate(input: { podId: "'"${pod_id}"'" }) }'
    runpod_api "${query}" >/dev/null
    log_info "Pod ${pod_id} terminated"
}

list_servers() {
    local query='query { myself { pods { id name desiredStatus runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } } } } }'
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
    runtime = p.get('runtime')
    if runtime and runtime.get('ports'):
        for port in runtime['ports']:
            if port.get('privatePort') == 22 and port.get('type') == 'tcp':
                ssh_info = f\"{port['ip']}:{port['publicPort']}\"
                break
        if ssh_info == 'N/A':
            ssh_info = f\"{pid}@ssh.runpod.io\"
    print(f'{name:<25} {pid:<25} {status:<12} {ssh_info:<30}')
" <<< "${response}"
}
