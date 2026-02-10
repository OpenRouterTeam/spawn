#!/bin/bash
# Common bash functions for Vast.ai spawn scripts
# Uses Vast.ai CLI (vastai) — https://vast.ai/docs/

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

# ============================================================
# Vast.ai specific functions
# ============================================================

# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-10}
SSH_RETRY_DELAY=${SSH_RETRY_DELAY:-5}

# Ensure vastai CLI is installed
ensure_vastai_cli() {
    if command -v vastai &>/dev/null; then
        return 0
    fi

    log_warn "Installing Vast.ai CLI..."
    pip install vastai 2>/dev/null || pip3 install vastai 2>/dev/null || {
        log_error "Failed to install vastai CLI"
        log_error "Please install manually: pip install vastai"
        return 1
    }
    log_info "Vast.ai CLI installed"
}

# Test Vast.ai API key validity
test_vastai_token() {
    local result
    result=$(vastai show instances 2>&1) || true

    if printf '%s' "${result}" | grep -qi "invalid\|unauthorized\|forbidden\|error.*key\|error.*auth"; then
        log_error "Invalid Vast.ai API key"
        log_warn "Get your API key from: https://cloud.vast.ai/account/"
        return 1
    fi
    return 0
}

# Ensure VASTAI_API_KEY is available (env var -> config file -> prompt+save)
ensure_vastai_token() {
    # Vast.ai CLI reads from ~/.vast_api_key, so check that too
    if [[ -z "${VASTAI_API_KEY:-}" ]] && [[ -f "${HOME}/.vast_api_key" ]]; then
        VASTAI_API_KEY=$(cat "${HOME}/.vast_api_key" 2>/dev/null)
        if [[ -n "${VASTAI_API_KEY}" ]]; then
            log_info "Using Vast.ai API key from ~/.vast_api_key"
            export VASTAI_API_KEY
        fi
    fi

    ensure_api_token_with_provider \
        "Vast.ai" \
        "VASTAI_API_KEY" \
        "${HOME}/.config/spawn/vastai.json" \
        "https://cloud.vast.ai/account/" \
        "test_vastai_token"

    # Also set the key for the vastai CLI
    vastai set api-key "${VASTAI_API_KEY}" >/dev/null 2>&1 || true
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "VASTAI_SERVER_NAME" "Enter instance name: ") || return 1

    if ! validate_server_name "${server_name}"; then
        return 1
    fi

    echo "${server_name}"
}

# Validate Vast.ai create_server parameters
# Usage: _validate_vastai_params DISK_GB IMAGE GPU_TYPE
_validate_vastai_params() {
    local disk_gb="${1}" image="${2}" gpu_type="${3}"

    if [[ ! "${disk_gb}" =~ ^[0-9]+$ ]]; then
        log_error "Invalid VASTAI_DISK_GB: must be numeric"
        return 1
    fi
    if [[ "${image}" =~ [\"\`\$\\] ]]; then
        log_error "Invalid VASTAI_IMAGE: contains unsafe characters"
        return 1
    fi
    if [[ "${gpu_type}" =~ [\"\`\$\\] ]]; then
        log_error "Invalid VASTAI_GPU_TYPE: contains unsafe characters"
        return 1
    fi
}

# Search for the cheapest available GPU offer on Vast.ai
# Prints the offer ID on success
# Usage: _find_cheapest_offer GPU_TYPE
_find_cheapest_offer() {
    local gpu_type="${1}"

    log_warn "Searching for available ${gpu_type} offers..."

    local offer_id
    offer_id=$(vastai search offers "gpu_name=${gpu_type} num_gpus=1 rentable=true inet_down>100 reliability>0.95" -o "dph_total" --raw 2>/dev/null | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if not data:
    sys.exit(1)
print(data[0]['id'])
" 2>/dev/null) || {
        log_error "No available offers found for GPU type: ${gpu_type}"
        log_warn "Try a different GPU type with VASTAI_GPU_TYPE (e.g., RTX_3090, RTX_4080)"
        log_warn "Browse available GPUs at: https://cloud.vast.ai/create/"
        return 1
    }

    log_info "Found offer: ${offer_id}"
    printf '%s' "${offer_id}"
}

# Create a Vast.ai instance from an offer and extract its ID
# Sets: VASTAI_INSTANCE_ID
# Usage: _create_vastai_instance OFFER_ID NAME IMAGE DISK_GB
_create_vastai_instance() {
    local offer_id="${1}" name="${2}" image="${3}" disk_gb="${4}"

    local create_output
    create_output=$(vastai create instance "${offer_id}" \
        --image "${image}" \
        --disk "${disk_gb}" \
        --ssh \
        --direct \
        --label "${name}" \
        --onstart-cmd "apt-get update -y && apt-get install -y curl unzip git zsh" \
        2>&1) || {
        log_error "Failed to create Vast.ai instance"
        log_error "${create_output}"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance (add funds at https://cloud.vast.ai/billing/)"
        log_warn "  - GPU type unavailable"
        return 1
    }

    # Extract instance ID from create output
    VASTAI_INSTANCE_ID=$(printf '%s' "${create_output}" | grep -oP "new instance is \K[0-9]+" 2>/dev/null || \
        printf '%s' "${create_output}" | python3 -c "
import sys, re
text = sys.stdin.read()
m = re.search(r'(\d{5,})', text)
if m:
    print(m.group(1))
else:
    sys.exit(1)
" 2>/dev/null) || {
        log_error "Could not extract instance ID from create output"
        log_error "Output: ${create_output}"
        return 1
    }

    export VASTAI_INSTANCE_ID
    log_info "Instance created: ID=${VASTAI_INSTANCE_ID}"
}

# Search for an available offer and create an instance
# Sets: VASTAI_INSTANCE_ID
create_server() {
    local name="${1}"
    local gpu_type="${VASTAI_GPU_TYPE:-RTX_4090}"
    local disk_gb="${VASTAI_DISK_GB:-40}"
    local image="${VASTAI_IMAGE:-nvidia/cuda:12.1.0-devel-ubuntu22.04}"

    _validate_vastai_params "${disk_gb}" "${image}" "${gpu_type}" || return 1

    local offer_id
    offer_id=$(_find_cheapest_offer "${gpu_type}") || return 1

    log_warn "Creating instance '${name}' (GPU: ${gpu_type}, image: ${image})..."
    _create_vastai_instance "${offer_id}" "${name}" "${image}" "${disk_gb}" || return 1

    wait_for_instance_ready "${VASTAI_INSTANCE_ID}"
}

# Wait for a Vast.ai instance to become ready and set SSH connection vars
# Sets: VASTAI_SSH_HOST, VASTAI_SSH_PORT
wait_for_instance_ready() {
    local instance_id="${1}"
    local max_attempts=${2:-60}
    local attempt=1

    log_warn "Waiting for instance to become ready..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        local status
        status=$(vastai show instances --raw 2>/dev/null | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for inst in data:
    if str(inst.get('id')) == '${instance_id}':
        print(inst.get('actual_status', 'unknown'))
        sys.exit(0)
print('not_found')
" 2>/dev/null || printf '%s' "unknown")

        if [[ "${status}" == "running" ]]; then
            # Get SSH connection info
            local ssh_url
            ssh_url=$(vastai ssh-url "${instance_id}" 2>/dev/null) || {
                log_warn "Instance running but SSH URL not yet available, retrying..."
                sleep "${INSTANCE_STATUS_POLL_DELAY}"
                attempt=$((attempt + 1))
                continue
            }

            # Parse SSH URL: ssh -p PORT root@HOST or ssh://root@HOST:PORT
            VASTAI_SSH_HOST=$(printf '%s' "${ssh_url}" | grep -oP '@\K[^ :]+' 2>/dev/null || \
                printf '%s' "${ssh_url}" | sed -n 's/.*@\([^: ]*\).*/\1/p')
            VASTAI_SSH_PORT=$(printf '%s' "${ssh_url}" | grep -oP '\-p\s*\K[0-9]+' 2>/dev/null || \
                printf '%s' "${ssh_url}" | grep -oP ':(\K[0-9]+)' 2>/dev/null || printf '%s' "22")

            if [[ -z "${VASTAI_SSH_HOST}" ]]; then
                log_warn "Could not parse SSH URL: ${ssh_url}, retrying..."
                sleep "${INSTANCE_STATUS_POLL_DELAY}"
                attempt=$((attempt + 1))
                continue
            fi

            export VASTAI_SSH_HOST VASTAI_SSH_PORT
            log_info "Instance ready: SSH at ${VASTAI_SSH_HOST}:${VASTAI_SSH_PORT}"
            return 0
        fi

        log_warn "Instance status: ${status} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become ready after ${max_attempts} attempts"
    return 1
}

# Build SSH options string for Vast.ai (uses non-standard port)
_vastai_ssh_opts() {
    printf '%s' "${SSH_OPTS} -o ConnectTimeout=10 -p ${VASTAI_SSH_PORT}"
}

verify_server_connectivity() {
    local max_attempts=${1:-30}
    local attempt=1
    local ssh_target="root@${VASTAI_SSH_HOST}"

    log_warn "Waiting for SSH connectivity to ${ssh_target}:${VASTAI_SSH_PORT}..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        # shellcheck disable=SC2086
        if ssh $(_vastai_ssh_opts) "${ssh_target}" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"
            return 0
        fi
        log_warn "Waiting for SSH... (${attempt}/${max_attempts})"
        sleep "${SSH_RETRY_DELAY}"
        attempt=$((attempt + 1))
    done
    log_error "Instance failed to respond via SSH after ${max_attempts} attempts"
    return 1
}

# Install base tools (Vast.ai instances are Docker containers)
install_base_tools() {
    local ssh_target="root@${VASTAI_SSH_HOST}"

    log_warn "Installing base tools..."
    # shellcheck disable=SC2086
    ssh $(_vastai_ssh_opts) "${ssh_target}" "apt-get update -y && apt-get install -y curl unzip git zsh npm" >/dev/null 2>&1 || true

    # Install Bun
    log_warn "Installing Bun..."
    # shellcheck disable=SC2086
    ssh $(_vastai_ssh_opts) "${ssh_target}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true

    # Install Claude Code
    log_warn "Installing Claude Code..."
    # shellcheck disable=SC2086
    ssh $(_vastai_ssh_opts) "${ssh_target}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true

    # Configure PATH in .bashrc and .zshrc
    # shellcheck disable=SC2086
    ssh $(_vastai_ssh_opts) "${ssh_target}" "grep -q '.bun/bin' ~/.bashrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc; grep -q '.bun/bin' ~/.zshrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc" >/dev/null 2>&1 || true

    log_info "Base tools installed"
}

# Vast.ai uses root user
# These functions follow the IP-first arg pattern for compatibility with inject_env_vars_ssh
# The "ip" arg is the instance ID (used for consistency, not for SSH target)
# shellcheck disable=SC2086
run_server() {
    local _ip="${1}"
    local cmd="${2}"
    ssh $(_vastai_ssh_opts) "root@${VASTAI_SSH_HOST}" "${cmd}"
}

# shellcheck disable=SC2086
upload_file() {
    local _ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    scp $(_vastai_ssh_opts) "${local_path}" "root@${VASTAI_SSH_HOST}:${remote_path}"
}

# shellcheck disable=SC2086
interactive_session() {
    local _ip="${1}"
    local cmd="${2}"
    ssh -t $(_vastai_ssh_opts) "root@${VASTAI_SSH_HOST}" "${cmd}"
}

destroy_server() {
    local instance_id="${1}"
    log_warn "Destroying instance ${instance_id}..."
    vastai destroy instance "${instance_id}" >/dev/null 2>&1
    log_info "Instance ${instance_id} destroyed"
}

list_servers() {
    vastai show instances --raw 2>/dev/null | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if not data:
    print('No instances found')
    sys.exit(0)
fmt = '{:<25} {:<12} {:<15} {:<12} {:<30}'
print(fmt.format('LABEL', 'ID', 'STATUS', 'GPU', 'SSH'))
print('-' * 94)
for inst in data:
    label = inst.get('label', 'N/A') or 'N/A'
    iid = str(inst.get('id', 'N/A'))
    status = inst.get('actual_status', 'N/A')
    gpu = inst.get('gpu_name', 'N/A')
    ssh_host = inst.get('ssh_host', '')
    ssh_port = inst.get('ssh_port', '')
    ssh_info = 'N/A'
    if ssh_host and ssh_port:
        ssh_info = '{}:{}'.format(ssh_host, ssh_port)
    print(fmt.format(label[:25], iid[:12], status[:15], gpu[:12], ssh_info[:30]))
" || {
        log_error "Failed to list instances"
        return 1
    }
}
