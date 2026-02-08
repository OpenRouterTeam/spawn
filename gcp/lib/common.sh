#!/bin/bash
# Common bash functions for GCP Compute Engine spawn scripts
# Uses gcloud CLI — requires Google Cloud SDK installed and configured

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
# GCP Compute Engine specific functions
# ============================================================

# Cache username to avoid repeated subprocess calls
GCP_USERNAME=$(whoami)

# SSH_OPTS is now defined in shared/common.sh

ensure_gcloud() {
    if ! command -v gcloud &>/dev/null; then
        log_error "Google Cloud SDK (gcloud) is required."
        log_error "Install: https://cloud.google.com/sdk/docs/install"
        return 1
    fi
    # Verify auth
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q '@'; then
        log_error "gcloud not authenticated. Run: gcloud auth login"
        return 1
    fi
    # Set project
    local project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
    if [[ -z "${project}" || "${project}" == "(unset)" ]]; then
        log_error "No GCP project set. Run: gcloud config set project YOUR_PROJECT"
        return 1
    fi
    export GCP_PROJECT="${project}"
    log_info "Using GCP project: ${project}"
}

ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"

    # Generate key if needed
    generate_ssh_key_if_missing "${key_path}"

    # GCP handles SSH keys via project/instance metadata, added during create
    log_info "SSH key ready"
}

get_server_name() {
    get_resource_name "GCP_INSTANCE_NAME" "Enter instance name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh
# Install Bun
su - $(logname 2>/dev/null || echo "$(whoami)") -c 'curl -fsSL https://bun.sh/install | bash' || true
# Install Claude Code
su - $(logname 2>/dev/null || echo "$(whoami)") -c 'curl -fsSL https://claude.ai/install.sh | bash' || true
# Configure PATH for all users
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /etc/profile.d/spawn.sh
chmod +x /etc/profile.d/spawn.sh
touch /tmp/.cloud-init-complete
CLOUD_INIT_EOF
}

create_server() {
    local name="${1}"
    local machine_type="${GCP_MACHINE_TYPE:-e2-medium}"
    local zone="${GCP_ZONE:-us-central1-a}"
    local image_family="ubuntu-2404-lts-amd64"
    local image_project="ubuntu-os-cloud"

    log_warn "Creating GCP instance '${name}' (type: ${machine_type}, zone: ${zone})..."

    local userdata
    userdata=$(get_cloud_init_userdata)
    local pub_key
    pub_key=$(cat "${HOME}/.ssh/id_ed25519.pub")

    if ! gcloud compute instances create "${name}" \
        --zone="${zone}" \
        --machine-type="${machine_type}" \
        --image-family="${image_family}" \
        --image-project="${image_project}" \
        --metadata="startup-script=${userdata},ssh-keys=${GCP_USERNAME}:${pub_key}" \
        --project="${GCP_PROJECT}" \
        --quiet \
        >/dev/null 2>&1; then
        log_error "Failed to create GCP instance"
        return 1
    fi

    export GCP_INSTANCE_NAME_ACTUAL="${name}"
    export GCP_ZONE="${zone}"

    # Get external IP
    GCP_SERVER_IP=$(gcloud compute instances describe "${name}" \
        --zone="${zone}" \
        --project="${GCP_PROJECT}" \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null)
    export GCP_SERVER_IP

    log_info "Instance created: IP=${GCP_SERVER_IP}"
}

verify_server_connectivity() {
    local ip="${1}" max_attempts=${2:-30}
    # Use shared generic_ssh_wait with exponential backoff
    # shellcheck disable=SC2086,SC2154
    generic_ssh_wait "${GCP_USERNAME}" "${ip}" "${SSH_OPTS}" "echo ok" "SSH connectivity" "${max_attempts}"
}

wait_for_cloud_init() {
    local ip="${1}" max_attempts=${2:-60}

    # First establish SSH connectivity using generic_ssh_wait
    generic_ssh_wait "${GCP_USERNAME}" "${ip}" "${SSH_OPTS}" "echo ok" "SSH connectivity" 30 5

    # Then wait for cloud-init completion marker
    generic_ssh_wait "${GCP_USERNAME}" "${ip}" "${SSH_OPTS}" "test -f /tmp/.cloud-init-complete" "startup script completion" "${max_attempts}" 5
}

# GCP uses current username
run_server() {
    local ip="${1}" cmd="${2}"
    # shellcheck disable=SC2086
    ssh ${SSH_OPTS} "${GCP_USERNAME}@${ip}" "${cmd}"
}

upload_file() {
    local ip="${1}" local_path="${2}" remote_path="${3}"
    # shellcheck disable=SC2086
    scp ${SSH_OPTS} "${local_path}" "${GCP_USERNAME}@${ip}:${remote_path}"
}

interactive_session() {
    local ip="${1}" cmd="${2}"
    # shellcheck disable=SC2086
    ssh -t ${SSH_OPTS} "${GCP_USERNAME}@${ip}" "${cmd}"
}

destroy_server() {
    local name="${1}"
    local zone="${GCP_ZONE:-us-central1-a}"
    log_warn "Destroying GCP instance ${name}..."
    gcloud compute instances delete "${name}" --zone="${zone}" --project="${GCP_PROJECT}" --quiet >/dev/null 2>&1
    log_info "Instance ${name} destroyed"
}

list_servers() {
    gcloud compute instances list --project="${GCP_PROJECT}" --format='table(name,zone,status,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP,machineType.basename())'
}
