#!/bin/bash
# Common bash functions for FluidStack spawn scripts
# Uses FluidStack REST API — https://docs.fluidstack.io/

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
# FluidStack specific functions
# ============================================================

readonly FLUIDSTACK_API_BASE="https://platform.fluidstack.io/v1"
# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-10}  # Delay between instance status checks
SSH_RETRY_DELAY=${SSH_RETRY_DELAY:-5}  # Delay between SSH connection retry attempts

# FluidStack API wrapper
# Usage: fluidstack_api METHOD ENDPOINT [BODY]
fluidstack_api() {
    local method="${1}"
    local endpoint="${2}"
    local body="${3:-}"

    if [[ -n "${body}" ]]; then
        curl -s -X "${method}" \
            -H "Content-Type: application/json" \
            -H "api-key: ${FLUIDSTACK_API_KEY}" \
            "${FLUIDSTACK_API_BASE}${endpoint}" \
            -d "${body}"
    else
        curl -s -X "${method}" \
            -H "api-key: ${FLUIDSTACK_API_KEY}" \
            "${FLUIDSTACK_API_BASE}${endpoint}"
    fi
}

test_fluidstack_token() {
    local response
    response=$(fluidstack_api GET "/ssh_keys")
    if echo "${response}" | grep -q '"ssh_keys"'; then
        log_info "API key validated"
        return 0
    else
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: ${error_msg}"
        log_warn "Remediation steps:"
        log_warn "  1. Verify API key at: https://platform.fluidstack.io/dashboard/api-keys"
        log_warn "  2. Ensure the key has appropriate permissions"
        log_warn "  3. Check key hasn't been revoked"
        return 1
    fi
}

# Ensure FLUIDSTACK_API_KEY is available (env var -> config file -> prompt+save)
ensure_fluidstack_token() {
    ensure_api_token_with_provider \
        "FluidStack" \
        "FLUIDSTACK_API_KEY" \
        "${HOME}/.config/spawn/fluidstack.json" \
        "https://platform.fluidstack.io/dashboard/api-keys" \
        "test_fluidstack_token"
}

# Check if SSH key is registered with FluidStack
fluidstack_check_ssh_key() {
    local fingerprint="${1}"
    local existing_keys
    existing_keys=$(fluidstack_api GET "/ssh_keys")
    # FluidStack returns SSH key fingerprints in MD5 format in "public_key_fingerprint" field
    echo "${existing_keys}" | _SPAWN_FINGERPRINT="${fingerprint}" python3 -c "
import json, sys, os
fingerprint = os.environ.get('_SPAWN_FINGERPRINT', '')
data = json.loads(sys.stdin.read())
for key in data.get('ssh_keys', []):
    if fingerprint in key.get('public_key_fingerprint', '') or fingerprint in key.get('name', ''):
        sys.exit(0)
sys.exit(1)
"
}

# Register SSH key with FluidStack
fluidstack_register_ssh_key() {
    local key_name="${1}"
    local pub_path="${2}"

    local register_body
    register_body=$(python3 -c "
import json, sys
pub_key = sys.stdin.read().strip()
print(json.dumps({
    'name': sys.argv[1],
    'public_key': pub_key
}))
" "${key_name}" < "${pub_path}")

    local register_response
    register_response=$(fluidstack_api POST "/ssh_keys" "${register_body}")

    if echo "${register_response}" | grep -q '"ssh_key_name"'; then
        return 0
    else
        local error_msg
        error_msg=$(echo "${register_response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "${register_response}")
        log_error "API Error: ${error_msg}"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered"
        log_warn "  - Invalid SSH key format"
        log_warn "  - API key lacks write permissions"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider fluidstack_check_ssh_key fluidstack_register_ssh_key "FluidStack"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "FLUIDSTACK_SERVER_NAME" "Enter instance name: ") || return 1

    if ! validate_server_name "${server_name}"; then
        return 1
    fi

    echo "${server_name}"
}

# Wait for FluidStack instance to become running and get its IP
# Sets: FLUIDSTACK_SERVER_IP
# Usage: wait_for_instance_ready INSTANCE_ID [MAX_ATTEMPTS]
wait_for_instance_ready() {
    local instance_id="${1}"
    local max_attempts=${2:-60}
    local attempt=1

    log_warn "Waiting for instance to become ready..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        local status_response
        status_response=$(fluidstack_api GET "/instances/${instance_id}")

        local status
        status=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('status','unknown'))" 2>/dev/null || echo "unknown")

        if [[ "${status}" == "running" ]]; then
            FLUIDSTACK_SERVER_IP=$(echo "${status_response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('ip_address',''))" 2>/dev/null || echo "")
            export FLUIDSTACK_SERVER_IP

            if [[ -z "${FLUIDSTACK_SERVER_IP}" ]]; then
                log_error "Instance running but no IP address assigned"
                return 1
            fi

            log_info "Instance ready: ${FLUIDSTACK_SERVER_IP}"
            return 0
        fi

        log_warn "Instance status: ${status} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become ready in time"
    return 1
}

create_server() {
    local name="${1}"
    local gpu_type="${FLUIDSTACK_GPU_TYPE:-RTX_4090}"
    local ssh_key_name="${FLUIDSTACK_SSH_KEY_NAME:-spawn-${USER}}"

    # Block injection chars in string values (quotes, backslashes)
    if [[ "${gpu_type}" =~ [\"\'\`\$\\] ]]; then log_error "Invalid FLUIDSTACK_GPU_TYPE: contains unsafe characters"; return 1; fi
    if [[ "${ssh_key_name}" =~ [\"\'\`\$\\] ]]; then log_error "Invalid FLUIDSTACK_SSH_KEY_NAME: contains unsafe characters"; return 1; fi

    log_warn "Creating FluidStack instance '${name}' (GPU: ${gpu_type})..."

    # Build instance creation request safely via stdin
    local create_body
    create_body=$(python3 -c "
import json, sys
parts = sys.stdin.read().strip().split('\n')
print(json.dumps({
    'gpu_type': parts[0],
    'ssh_key': parts[1]
}))
" <<< "${gpu_type}
${ssh_key_name}")

    local response
    response=$(fluidstack_api POST "/instances" "${create_body}")

    if echo "${response}" | grep -q '"instance_id"'; then
        FLUIDSTACK_INSTANCE_ID=$(echo "${response}" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('instance_id',''))")
        export FLUIDSTACK_INSTANCE_ID
        log_info "Instance created: ID=${FLUIDSTACK_INSTANCE_ID}"

        wait_for_instance_ready "${FLUIDSTACK_INSTANCE_ID}"
    else
        log_error "Failed to create FluidStack instance"
        local error_msg
        error_msg=$(echo "${response}" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "${response}")
        log_error "API Error: ${error_msg}"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - GPU type unavailable (try different FLUIDSTACK_GPU_TYPE)"
        log_warn "  - SSH key not found (check FLUIDSTACK_SSH_KEY_NAME)"
        log_warn "Remediation: Check https://platform.fluidstack.io/dashboard"
        return 1
    fi
}

verify_server_connectivity() {
    local max_attempts=${1:-30}
    generic_ssh_wait "${FLUIDSTACK_SERVER_IP}" "root" "${max_attempts}"
}

# Install base tools via SSH
install_base_tools() {
    log_warn "Installing base tools..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${FLUIDSTACK_SERVER_IP}" "apt-get update -y && apt-get install -y curl unzip git zsh npm" >/dev/null 2>&1 || true

    # Install Bun
    log_warn "Installing Bun..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${FLUIDSTACK_SERVER_IP}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true

    # Install Claude Code
    log_warn "Installing Claude Code..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${FLUIDSTACK_SERVER_IP}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true

    # Configure PATH in .bashrc and .zshrc
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${FLUIDSTACK_SERVER_IP}" "grep -q '.bun/bin' ~/.bashrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.bashrc; grep -q '.bun/bin' ~/.zshrc 2>/dev/null || printf '%s\n' 'export PATH=\"\${HOME}/.claude/local/bin:\${HOME}/.bun/bin:\${PATH}\"' >> ~/.zshrc" >/dev/null 2>&1 || true

    log_info "Base tools installed"
}

# FluidStack uses root user for SSH access
run_server() {
    local ip="${1}"
    local cmd="${2}"
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "root@${ip}" "${cmd}"
}

upload_file() {
    local ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    # shellcheck disable=SC2086
    scp ${SSH_OPTS} "${local_path}" "root@${ip}:${remote_path}"
}

interactive_session() {
    local ip="${1}"
    local cmd="${2}"
    # shellcheck disable=SC2086
    ssh -t ${SSH_OPTS} "root@${ip}" "${cmd}"
}

destroy_server() {
    local instance_id="${1}"
    log_warn "Terminating instance ${instance_id}..."
    fluidstack_api DELETE "/instances/${instance_id}" >/dev/null
    log_info "Instance ${instance_id} terminated"
}

list_servers() {
    local response
    response=$(fluidstack_api GET "/instances")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('instances', [])
if not instances:
    print('No instances found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<30} {'STATUS':<12} {'IP':<15} {'GPU':<15}\")
print('-' * 97)
for inst in instances:
    name = inst.get('hostname', inst.get('instance_id', 'N/A'))[:24]
    iid = inst.get('instance_id', 'N/A')[:29]
    status = inst.get('status', 'N/A')[:11]
    ip = inst.get('ip_address', 'N/A')[:14]
    gpu = inst.get('gpu_type', 'N/A')[:14]
    print(f'{name:<25} {iid:<30} {status:<12} {ip:<15} {gpu:<15}')
" <<< "${response}"
}
