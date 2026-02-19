#!/bin/bash
# Common bash functions for AWS Lightsail spawn scripts
# Uses AWS CLI (aws lightsail) — requires `aws` CLI configured with credentials

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
# AWS Lightsail specific functions
# ============================================================

SPAWN_DASHBOARD_URL="https://lightsail.aws.amazon.com/"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

ensure_aws_cli() {
    if ! command -v aws &>/dev/null; then
        _log_diagnostic \
            "AWS CLI is required but not installed" \
            "aws command not found in PATH" \
            --- \
            "Install the AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" \
            "Or on macOS: brew install awscli"
        return 1
    fi
    # Verify credentials are configured
    if ! aws sts get-caller-identity &>/dev/null; then
        _log_diagnostic \
            "AWS CLI is not configured with valid credentials" \
            "No AWS credentials found or credentials have expired" \
            --- \
            "Run: aws configure" \
            "Or set environment variables: export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=..."
        return 1
    fi
    local region="${AWS_DEFAULT_REGION:-${LIGHTSAIL_REGION:-us-east-1}}"
    export AWS_DEFAULT_REGION="${region}"
    log_info "Using AWS region: ${region}"
}

ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "${key_path}"

    # Validate SSH public key path before upload
    if [[ ! -f "${pub_path}" ]]; then
        log_error "SSH public key not found: ${pub_path}"
        return 1
    fi
    if [[ -L "${pub_path}" ]]; then
        log_error "SSH public key cannot be a symlink: ${pub_path}"
        return 1
    fi
    # SSH public keys are typically 100-600 bytes (ed25519/RSA)
    # Reject suspiciously large files to prevent arbitrary file upload
    local size
    size=$(wc -c <"${pub_path}")
    if [[ ${size} -gt 10000 ]]; then
        log_error "SSH public key file too large: ${size} bytes (max 10000)"
        return 1
    fi

    local key_name="spawn-key"

    # Check if already registered
    if aws lightsail get-key-pair --key-pair-name "${key_name}" &>/dev/null; then
        log_info "SSH key already registered with Lightsail"
        return 0
    fi

    log_step "Importing SSH key to Lightsail..."
    # --public-key-base64 accepts the OpenSSH key directly (not base64-wrapped)
    aws lightsail import-key-pair \
        --key-pair-name "${key_name}" \
        --public-key-base64 "$(cat "${pub_path}")" \
        >/dev/null 2>&1 || {
        # Race condition: another process may have imported it
        if aws lightsail get-key-pair --key-pair-name "${key_name}" &>/dev/null; then
            log_info "SSH key already registered with Lightsail"
            return 0
        fi
        log_error "Failed to import SSH key to Lightsail"
        return 1
    }
    log_info "SSH key imported to Lightsail"
}

get_server_name() {
    get_resource_name "LIGHTSAIL_SERVER_NAME" "Enter Lightsail instance name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh nodejs npm
# Upgrade Node.js to v22 LTS (apt has v18, agents like Cline need v20+)
# n installs to /usr/local/bin but apt's v18 at /usr/bin can shadow it, so symlink over
npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx
# Install Bun
su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'
# Install Claude Code
su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash'
# Configure npm global prefix so ubuntu can npm install -g without sudo
su - ubuntu -c 'mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global'
# Configure PATH
echo 'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.bashrc
echo 'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.zshrc
chown ubuntu:ubuntu /home/ubuntu/.bashrc /home/ubuntu/.zshrc
touch /home/ubuntu/.cloud-init-complete
chown ubuntu:ubuntu /home/ubuntu/.cloud-init-complete
CLOUD_INIT_EOF
}

# Wait for Lightsail instance to become running and get its public IP
# Sets: LIGHTSAIL_SERVER_IP
# Usage: _wait_for_lightsail_instance NAME [MAX_ATTEMPTS]
_wait_for_lightsail_instance() {
    local name="${1}"
    local max_attempts=${2:-60}
    local attempt=1

    log_step "Waiting for instance to become running..."
    while [[ ${attempt} -le ${max_attempts} ]]; do
        local state
        state=$(aws lightsail get-instance --instance-name "${name}" \
            --query 'instance.state.name' --output text 2>/dev/null)

        if [[ "${state}" == "running" ]]; then
            LIGHTSAIL_SERVER_IP=$(aws lightsail get-instance --instance-name "${name}" \
                --query 'instance.publicIpAddress' --output text)
            export LIGHTSAIL_SERVER_IP
            log_info "Instance running: IP=${LIGHTSAIL_SERVER_IP}"
            return 0
        fi
        log_step "Instance state: ${state} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become running after ${max_attempts} checks"
    log_warn "The instance may still be provisioning. You can:"
    log_warn "  1. Re-run the command to try again"
    log_warn "  2. Check the instance status: aws lightsail get-instance --instance-name '${name}'"
    log_warn "  3. Check the Lightsail console: https://lightsail.aws.amazon.com/"
    return 1
}

create_server() {
    local name="${1}"
    local bundle="${LIGHTSAIL_BUNDLE:-medium_3_0}"
    local region="${AWS_DEFAULT_REGION:-us-east-1}"
    local az="${region}a"
    local blueprint="ubuntu_24_04"

    # Validate env var inputs to prevent command injection
    validate_resource_name "${bundle}" || { log_error "Invalid LIGHTSAIL_BUNDLE"; return 1; }
    validate_region_name "${region}" || { log_error "Invalid AWS_DEFAULT_REGION"; return 1; }

    log_step "Creating Lightsail instance '${name}' (bundle: ${bundle}, AZ: ${az})..."

    local userdata
    userdata=$(get_cloud_init_userdata)

    if ! aws lightsail create-instances \
        --instance-names "${name}" \
        --availability-zone "${az}" \
        --blueprint-id "${blueprint}" \
        --bundle-id "${bundle}" \
        --key-pair-name "spawn-key" \
        --user-data "${userdata}" \
        >/dev/null; then
        log_error "Failed to create Lightsail instance"
        log_warn "Common issues:"
        log_warn "  - Instance limit reached for your account"
        log_warn "  - Bundle unavailable in region (try different LIGHTSAIL_BUNDLE or LIGHTSAIL_REGION)"
        log_warn "  - AWS credentials lack Lightsail permissions (check IAM policy)"
        log_warn "  - Instance name '${name}' already in use"
        return 1
    fi

    export LIGHTSAIL_INSTANCE_NAME="${name}"
    log_info "Instance creation initiated: ${name}"

    _wait_for_lightsail_instance "${name}"

    save_vm_connection "${LIGHTSAIL_SERVER_IP}" "ubuntu" "" "$name" "aws"
}

# Lightsail uses 'ubuntu' user, not 'root'
SSH_USER="ubuntu"

# SSH operations — delegates to shared helpers
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

wait_for_cloud_init() {
    local ip="${1}"
    local max_attempts=${2:-60}

    # First ensure SSH connectivity is established
    ssh_verify_connectivity "${ip}" 30 5 || return 1

    # Then wait for cloud-init completion marker
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS}" "test -f /home/ubuntu/.cloud-init-complete" "cloud-init" "${max_attempts}" 5
}

destroy_server() {
    local name="${1}"
    log_step "Destroying Lightsail instance ${name}..."
    aws lightsail delete-instance --instance-name "${name}" >/dev/null
    log_info "Instance ${name} destroyed"
}

list_servers() {
    aws lightsail get-instances --query 'instances[].{Name:name,State:state.name,IP:publicIpAddress,Bundle:bundleId}' --output table
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_aws_cli; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${LIGHTSAIL_SERVER_IP}"; wait_for_cloud_init "${LIGHTSAIL_SERVER_IP}" 60; }
cloud_run() { run_server "${LIGHTSAIL_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${LIGHTSAIL_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${LIGHTSAIL_SERVER_IP}" "$1"; }
cloud_label() { echo "Lightsail instance"; }
