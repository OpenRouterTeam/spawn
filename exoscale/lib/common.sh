#!/bin/bash
set -eo pipefail
# Common bash functions for Exoscale spawn scripts

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

# Note: Provider-agnostic functions (logging, OAuth, browser) are now in shared/common.sh

# ============================================================
# Exoscale specific functions
# ============================================================

readonly EXOSCALE_DEFAULT_ZONE="${EXOSCALE_ZONE:-ch-gva-2}"
readonly EXOSCALE_DEFAULT_INSTANCE_TYPE="${EXOSCALE_INSTANCE_TYPE:-standard.small}"
readonly EXOSCALE_DEFAULT_TEMPLATE="Ubuntu 24.04 LTS 64-bit"

# Test Exoscale CLI authentication
test_exoscale_auth() {
    if ! exo config show >/dev/null 2>&1; then
        log_error "Exoscale CLI not configured"
        log_error ""
        log_error "Run: exo config"
        log_error "Get API credentials from: https://portal.exoscale.com/iam/api-keys"
        return 1
    fi

    if ! exo compute instance-type list --zone "${EXOSCALE_DEFAULT_ZONE}" >/dev/null 2>&1; then
        log_error "Exoscale authentication failed"
        log_error ""
        log_error "Your API credentials may be invalid or expired."
        log_error "Run: exo config"
        log_error "Get new credentials from: https://portal.exoscale.com/iam/api-keys"
        return 1
    fi

    return 0
}

# Ensure Exoscale CLI is installed and configured
ensure_exoscale_cli() {
    # Check if exo CLI is installed
    if ! command -v exo &> /dev/null; then
        log_warn "Exoscale CLI (exo) not found, installing..."

        if ! curl -fsSL https://raw.githubusercontent.com/exoscale/cli/master/install-latest.sh | sh; then
            log_error "Failed to install Exoscale CLI"
            log_error ""
            log_error "Install manually:"
            log_error "  macOS/Linux: curl -fsSL https://raw.githubusercontent.com/exoscale/cli/master/install-latest.sh | sh"
            log_error "  Or download from: https://github.com/exoscale/cli/releases"
            return 1
        fi

        # Add to PATH if needed
        if [[ ! -d "${HOME}/.exoscale/bin" ]]; then
            log_error "Exoscale CLI installation failed - binary not found"
            return 1
        fi

        export PATH="${HOME}/.exoscale/bin:${PATH}"

        if ! command -v exo &> /dev/null; then
            log_error "Exoscale CLI installation failed"
            log_error "Try adding to PATH: export PATH=\"\${HOME}/.exoscale/bin:\${PATH}\""
            return 1
        fi

        log_info "Exoscale CLI installed successfully"
    fi

    # Check if CLI is configured
    if ! exo config show >/dev/null 2>&1; then
        log_warn "Exoscale CLI not configured"
        log_warn "Get API credentials from: https://portal.exoscale.com/iam/api-keys"
        echo ""

        # Interactive config
        if ! exo config; then
            log_error "Exoscale CLI configuration failed"
            return 1
        fi
    fi

    # Test authentication
    if ! test_exoscale_auth; then
        return 1
    fi

    log_info "Exoscale CLI configured successfully"
    return 0
}

# Generate SSH key if it doesn't exist and get the public key
ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"
    generate_ssh_key_if_missing "${key_path}"
}

# Get instance name from env var or prompt
get_instance_name() {
    local instance_name
    instance_name=$(get_resource_name "EXOSCALE_INSTANCE_NAME" "Enter instance name: ") || return 1

    if ! validate_server_name "${instance_name}"; then
        return 1
    fi

    echo "${instance_name}"
}

# Get cloud-init userdata - use shared function
# get_cloud_init_userdata is defined in shared/common.sh

# Create security group with SSH access if it doesn't exist
ensure_security_group() {
    log_warn "Ensuring security group allows SSH..."

    # Check if default security group exists and has SSH rule
    local sg_rules
    sg_rules=$(exo compute security-group show default --zone "${EXOSCALE_DEFAULT_ZONE}" 2>/dev/null || echo "")

    if [[ -z "${sg_rules}" ]]; then
        log_warn "Creating default security group..."
        exo compute security-group create default --zone "${EXOSCALE_DEFAULT_ZONE}"
    fi

    # Check if SSH rule exists
    if ! echo "${sg_rules}" | grep -q "22.*ingress" && ! exo compute security-group show default --zone "${EXOSCALE_DEFAULT_ZONE}" 2>/dev/null | grep -q "22.*ingress"; then
        log_warn "Adding SSH rule to security group..."
        exo compute security-group rule add default --zone "${EXOSCALE_DEFAULT_ZONE}" \
            --network 0.0.0.0/0 --port 22 --protocol tcp
    fi

    log_info "Security group configured for SSH access"
}

# Create an Exoscale compute instance with cloud-init
create_instance() {
    local name="${1}"
    local zone="${EXOSCALE_DEFAULT_ZONE}"
    local instance_type="${EXOSCALE_DEFAULT_INSTANCE_TYPE}"
    local template="${EXOSCALE_DEFAULT_TEMPLATE}"

    # Validate env var inputs
    validate_resource_name "${instance_type}" || { log_error "Invalid EXOSCALE_INSTANCE_TYPE"; return 1; }
    validate_region_name "${zone}" || { log_error "Invalid EXOSCALE_ZONE"; return 1; }

    log_warn "Creating Exoscale instance '${name}' (type: ${instance_type}, zone: ${zone})..."

    # Ensure security group allows SSH
    ensure_security_group

    # Get cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)

    # Save userdata to temp file
    local userdata_file
    userdata_file=$(mktemp)
    chmod 600 "${userdata_file}"
    track_temp_file "${userdata_file}"
    echo "${userdata}" > "${userdata_file}"

    # Create instance with cloud-init
    local create_output
    if ! create_output=$(exo compute instance create "${name}" \
        --zone "${zone}" \
        --instance-type "${instance_type}" \
        --template "${template}" \
        --cloud-init-file "${userdata_file}" \
        --ssh-key "${HOME}/.ssh/id_ed25519.pub" \
        --security-group default \
        2>&1); then
        log_error "Failed to create Exoscale instance"
        log_error "${create_output}"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance"
        log_error "  - Instance type unavailable in zone (try different EXOSCALE_INSTANCE_TYPE or EXOSCALE_ZONE)"
        log_error "  - Instance limit reached for your account"
        log_error "  - Invalid cloud-init userdata"
        log_error ""
        log_error "Check your account: https://portal.exoscale.com/"
        return 1
    fi

    # Extract instance IP from output
    log_warn "Waiting for instance to get an IP address..."
    sleep 5

    local instance_ip
    instance_ip=$(exo compute instance show "${name}" --zone "${zone}" -O json | \
        python3 -c "import json,sys; print(json.load(sys.stdin).get('public-ip', ''))" 2>/dev/null || echo "")

    if [[ -z "${instance_ip}" ]]; then
        log_error "Failed to get instance IP address"
        log_error "Instance may still be starting. Check: exo compute instance show ${name} --zone ${zone}"
        return 1
    fi

    export EXOSCALE_INSTANCE_NAME="${name}"
    export EXOSCALE_INSTANCE_IP="${instance_ip}"
    export EXOSCALE_INSTANCE_ZONE="${zone}"

    log_info "Instance created: Name=${name}, IP=${instance_ip}, Zone=${zone}"
}

# Wait for SSH connectivity
verify_instance_connectivity() {
    local ip="${1}"
    local max_attempts=${2:-30}
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS} -o ConnectTimeout=5" "echo ok" "SSH connectivity" "${max_attempts}" 5
}

# Run a command on the instance
run_instance() {
    local ip="${1}"
    local cmd="${2}"
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "ubuntu@${ip}" "${cmd}"
}

# Upload a file to the instance
upload_file() {
    local ip="${1}"
    local local_path="${2}"
    local remote_path="${3}"
    # shellcheck disable=SC2086
    scp ${SSH_OPTS} "${local_path}" "ubuntu@${ip}:${remote_path}"
}

# Start an interactive SSH session
interactive_session() {
    local ip="${1}"
    local cmd="${2:-zsh}"
    log_info "Starting interactive session (exit with Ctrl+D or 'exit')..."
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} -t "ubuntu@${ip}" "${cmd}"
}
