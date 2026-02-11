#!/bin/bash
# Common bash functions for Crusoe Cloud spawn scripts
# Uses Crusoe CLI — requires `crusoe` CLI configured with credentials

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
# Crusoe Cloud specific functions
# ============================================================

# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
VM_STATUS_POLL_DELAY=${VM_STATUS_POLL_DELAY:-5}  # Delay between VM status checks

ensure_crusoe_cli() {
    if ! command -v crusoe &>/dev/null; then
        log_error "Crusoe CLI is required but not installed"
        log_error ""
        log_error "Install instructions:"
        log_error "  Debian/Ubuntu:"
        log_error "    echo \"deb [trusted=yes] https://apt.fury.io/crusoe/ * *\" | sudo tee /etc/apt/sources.list.d/fury.list"
        log_error "    sudo apt update && sudo apt install crusoe"
        log_error ""
        log_error "  macOS/Other:"
        log_error "    Visit: https://docs.crusoecloud.com/quickstart/install-cli"
        log_error ""
        return 1
    fi

    # Check if configured
    if [[ ! -f "${HOME}/.crusoe/config" ]]; then
        log_error "Crusoe CLI not configured"
        log_error ""
        log_error "Configuration required:"
        log_error "  1. Generate API key at: https://console.crusoecloud.com/"
        log_error "     Navigate to: Security → API Access → Create Access Key"
        log_error ""
        log_error "  2. Create config file at: ~/.crusoe/config"
        log_error ""
        log_error "  Config format:"
        log_error "    [default]"
        log_error "    default_project=\"default\""
        log_error "    access_key_id=\"YOUR_ACCESS_KEY_ID\""
        log_error "    secret_key=\"YOUR_SECRET_KEY\""
        log_error ""
        return 1
    fi

    # Verify credentials work by listing VMs
    if ! crusoe compute vms list &>/dev/null; then
        log_error "Crusoe CLI credentials invalid or expired"
        log_error ""
        log_error "Please regenerate credentials at: https://console.crusoecloud.com/"
        log_error "Then update: ~/.crusoe/config"
        return 1
    fi

    log_info "Crusoe CLI configured"
}

ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "${key_path}"

    # Crusoe CLI uses --keyfile flag or CRUSOE_SSH_PUBLIC_KEY_FILE env var
    # No registration needed - key is passed at VM creation time
    export CRUSOE_SSH_PUBLIC_KEY_FILE="${pub_path}"
    log_info "SSH key ready: ${pub_path}"
}

get_vm_name() {
    get_resource_name "CRUSOE_VM_NAME" "Enter Crusoe VM name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh
# Install Bun
curl -fsSL https://bun.sh/install | bash
# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
# Configure PATH in root's bashrc and zshrc
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.bashrc
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.zshrc
touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

# Wait for Crusoe VM to become running and get its public IP
# Sets: CRUSOE_VM_IP
# Usage: _wait_for_crusoe_vm NAME [MAX_ATTEMPTS]
_wait_for_crusoe_vm() {
    local name="${1}"
    local max_attempts=${2:-60}
    local attempt=1

    log_warn "Waiting for VM to become running..."
    while [[ ${attempt} -le ${max_attempts} ]]; do
        local state
        state=$(crusoe compute vms get "${name}" --output json 2>/dev/null | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('state','unknown'))" 2>/dev/null || echo "unknown")

        if [[ "${state}" == "RUNNING" ]]; then
            CRUSOE_VM_IP=$(crusoe compute vms get "${name}" --output json | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('network_interfaces',[{}])[0].get('public_ipv4',{}).get('address',''))")
            export CRUSOE_VM_IP

            if [[ -z "${CRUSOE_VM_IP}" ]]; then
                log_error "VM is running but has no public IP"
                return 1
            fi

            log_info "VM running: IP=${CRUSOE_VM_IP}"
            return 0
        fi
        log_warn "VM state: ${state} (${attempt}/${max_attempts})"
        sleep "${VM_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "VM did not become running in time"
    return 1
}

create_vm() {
    local name="${1}"
    local vm_type="${CRUSOE_VM_TYPE:-a40.1x}"
    local location="${CRUSOE_LOCATION:-us-east1-a}"
    local image="ubuntu22.04:latest"

    # Validate env var inputs to prevent command injection
    validate_resource_name "${vm_type}" || { log_error "Invalid CRUSOE_VM_TYPE"; return 1; }
    validate_region_name "${location}" || { log_error "Invalid CRUSOE_LOCATION"; return 1; }

    log_warn "Creating Crusoe VM '${name}' (type: ${vm_type}, location: ${location})..."

    local userdata
    userdata=$(get_cloud_init_userdata)

    # Write userdata to temp file for --startup-script flag
    local userdata_file
    userdata_file=$(mktemp)
    echo "${userdata}" > "${userdata_file}"

    if ! crusoe compute vms create \
        --name "${name}" \
        --type "${vm_type}" \
        --location "${location}" \
        --image "${image}" \
        --keyfile "${CRUSOE_SSH_PUBLIC_KEY_FILE}" \
        --startup-script "${userdata_file}" \
        >/dev/null 2>&1; then
        rm -f "${userdata_file}"
        log_error "Failed to create Crusoe VM"
        log_error ""
        log_error "Common causes:"
        log_error "  - VM name already exists"
        log_error "  - Invalid VM type (use: crusoe compute vm-types list)"
        log_error "  - Invalid location (use: crusoe compute datacenter-regions list)"
        log_error "  - Insufficient quota or credits"
        return 1
    fi

    rm -f "${userdata_file}"
    export CRUSOE_VM_NAME="${name}"
    log_info "VM creation initiated: ${name}"

    # Wait for VM to be running
    if ! _wait_for_crusoe_vm "${name}"; then
        return 1
    fi

    # Wait for SSH to be ready
    log_warn "Waiting for SSH to become available..."
    if ! generic_ssh_wait "root" "${CRUSOE_VM_IP}" 300; then
        log_error "SSH did not become available in time"
        return 1
    fi

    # Wait for cloud-init to complete
    log_warn "Waiting for cloud-init setup to complete..."
    local init_wait=0
    while [[ ${init_wait} -lt 300 ]]; do
        if ssh ${SSH_OPTS} -o ConnectTimeout=5 "root@${CRUSOE_VM_IP}" "test -f /root/.cloud-init-complete" 2>/dev/null; then
            log_info "Cloud-init setup complete"
            return 0
        fi
        sleep 5
        init_wait=$((init_wait + 5))
    done

    log_error "Cloud-init did not complete in time"
    return 1
}

cleanup_vm() {
    local name="${1:-${CRUSOE_VM_NAME}}"
    if [[ -z "${name}" ]]; then
        log_warn "No VM name provided, skipping cleanup"
        return 0
    fi

    log_warn "Cleaning up Crusoe VM: ${name}"
    if crusoe compute vms delete "${name}" --confirm &>/dev/null; then
        log_info "VM deleted: ${name}"
    else
        log_warn "Failed to delete VM (may not exist): ${name}"
    fi
}

# Verify SSH connectivity to VM
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # SSH_OPTS is defined in shared/common.sh
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

# Run a command on the VM
run_server() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

# Upload a file to the VM
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    # shellcheck disable=SC2086
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}
