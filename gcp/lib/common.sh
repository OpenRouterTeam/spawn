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

# Verify gcloud CLI is installed
_gcp_check_cli_installed() {
    if ! command -v gcloud &>/dev/null; then
        _log_diagnostic \
            "Google Cloud SDK (gcloud) is required but not installed" \
            "gcloud CLI has not been installed on this machine" \
            --- \
            "Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install" \
            "Or on macOS: brew install google-cloud-sdk"
        return 1
    fi
}

# Verify gcloud has an active authenticated account
_gcp_check_auth() {
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q '@'; then
        _log_diagnostic \
            "gcloud is not authenticated" \
            "No active Google Cloud account found" \
            "Previous authentication may have expired" \
            --- \
            "Run: gcloud auth login" \
            "Or set credentials via: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json"
        return 1
    fi
}

# Resolve and export GCP_PROJECT from env var or gcloud config
_gcp_resolve_project() {
    local project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
    if [[ -z "${project}" || "${project}" == "(unset)" ]]; then
        _log_diagnostic \
            "No GCP project configured" \
            "No project is set in gcloud config or GCP_PROJECT env var" \
            --- \
            "Set via environment: export GCP_PROJECT=your-project-id" \
            "Or via gcloud: gcloud config set project YOUR_PROJECT" \
            "List your projects: gcloud projects list"
        return 1
    fi
    export GCP_PROJECT="${project}"
    log_info "Using GCP project: ${project}"
}

ensure_gcloud() {
    _gcp_check_cli_installed || return 1
    _gcp_check_auth || return 1
    _gcp_resolve_project
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

# Prepare startup script and SSH metadata temp files for gcloud instance creation
# Sets startup_script_file and pub_key variables in caller's scope
_gcp_prepare_instance_files() {
    startup_script_file=$(mktemp)
    track_temp_file "${startup_script_file}"
    get_cloud_init_userdata > "${startup_script_file}"

    pub_key=$(cat "${HOME}/.ssh/id_ed25519.pub")
}

# Run gcloud compute instances create and handle errors
# Returns 0 on success, 1 on failure with diagnostic output
_gcp_run_create() {
    local name="${1}" zone="${2}" machine_type="${3}"
    local image_family="${4}" image_project="${5}" startup_script_file="${6}" pub_key="${7}"

    local gcloud_err
    gcloud_err=$(mktemp)
    track_temp_file "${gcloud_err}"

    if gcloud compute instances create "${name}" \
        --zone="${zone}" \
        --machine-type="${machine_type}" \
        --image-family="${image_family}" \
        --image-project="${image_project}" \
        --metadata-from-file="startup-script=${startup_script_file}" \
        --metadata="ssh-keys=${GCP_USERNAME}:${pub_key}" \
        --project="${GCP_PROJECT}" \
        --quiet \
        >/dev/null 2>"${gcloud_err}"; then
        return 0
    fi

    log_error "Failed to create GCP instance"
    local err_output
    err_output=$(cat "${gcloud_err}" 2>/dev/null)
    if [[ -n "${err_output}" ]]; then
        log_error "gcloud error: ${err_output}"
    fi
    log_warn "Common issues:"
    log_warn "  - Billing not enabled for the project (enable at https://console.cloud.google.com/billing)"
    log_warn "  - Compute Engine API not enabled (enable at https://console.cloud.google.com/apis)"
    log_warn "  - Instance quota exceeded in zone (try different GCP_ZONE)"
    log_warn "  - Machine type unavailable in zone (try different GCP_MACHINE_TYPE or GCP_ZONE)"
    return 1
}

# Get the external IP of a GCP instance
# Usage: _gcp_get_instance_ip NAME ZONE
_gcp_get_instance_ip() {
    local name="${1}" zone="${2}"
    gcloud compute instances describe "${name}" \
        --zone="${zone}" \
        --project="${GCP_PROJECT}" \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null
}

create_server() {
    local name="${1}"
    local machine_type="${GCP_MACHINE_TYPE:-e2-medium}"
    local zone="${GCP_ZONE:-us-central1-a}"
    local image_family="ubuntu-2404-lts-amd64"
    local image_project="ubuntu-os-cloud"

    # Validate env var inputs to prevent command injection
    validate_resource_name "${machine_type}" || { log_error "Invalid GCP_MACHINE_TYPE"; return 1; }
    validate_region_name "${zone}" || { log_error "Invalid GCP_ZONE"; return 1; }

    log_step "Creating GCP instance '${name}' (type: ${machine_type}, zone: ${zone})..."

    local startup_script_file pub_key
    _gcp_prepare_instance_files

    _gcp_run_create "${name}" "${zone}" "${machine_type}" \
        "${image_family}" "${image_project}" "${startup_script_file}" "${pub_key}" || return 1

    # shellcheck disable=SC2034  # Variables exported for use by sourcing scripts
    export GCP_INSTANCE_NAME_ACTUAL="${name}"
    export GCP_ZONE="${zone}"
    export GCP_SERVER_IP="$(_gcp_get_instance_ip "${name}" "${zone}")"

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
    log_step "Destroying GCP instance ${name}..."
    gcloud compute instances delete "${name}" --zone="${zone}" --project="${GCP_PROJECT}" --quiet >/dev/null 2>&1
    log_info "Instance ${name} destroyed"
}

list_servers() {
    gcloud compute instances list --project="${GCP_PROJECT}" --format='table(name,zone,status,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP,machineType.basename())'
}
