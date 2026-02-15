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
SSH_USER="${GCP_USERNAME}"

SPAWN_DASHBOARD_URL="https://console.cloud.google.com/compute/instances"

# SSH_OPTS is now defined in shared/common.sh

# Verify gcloud CLI is installed
_gcp_check_cli_installed() {
    if ! command -v gcloud &>/dev/null; then
        log_error "Google Cloud SDK (gcloud) is required but not installed"
        log_error ""
        log_error "Possible causes:"
        log_error "  - gcloud CLI has not been installed on this machine"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Install gcloud CLI for your platform:"
        log_error ""
        log_error "     ${CYAN}macOS (Homebrew)${NC}"
        log_error "     brew install google-cloud-sdk"
        log_error ""
        log_error "     ${CYAN}Ubuntu/Debian${NC}"
        log_error "     curl https://sdk.cloud.google.com | bash"
        log_error "     exec -l \$SHELL  # Restart shell"
        log_error ""
        log_error "     ${CYAN}Fedora/RHEL${NC}"
        log_error "     sudo tee -a /etc/yum.repos.d/google-cloud-sdk.repo << EOM"
        log_error "     [google-cloud-cli]"
        log_error "     name=Google Cloud CLI"
        log_error "     baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el9-x86_64"
        log_error "     enabled=1"
        log_error "     gpgcheck=1"
        log_error "     repo_gpgcheck=0"
        log_error "     gpgkey=https://packages.cloud.google.com/yum/doc/rpm-package-key.gpg"
        log_error "     EOM"
        log_error "     sudo dnf install google-cloud-cli"
        log_error ""
        log_error "  2. Full installation guide: ${CYAN}https://cloud.google.com/sdk/docs/install${NC}"
        log_error ""
        log_error "  3. After installation, authenticate:"
        log_error "     gcloud auth login"
        log_error "     gcloud config set project YOUR_PROJECT_ID"
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
        log_error "No GCP project configured"
        log_error ""
        log_error "Possible causes:"
        log_error "  - No project is set in gcloud config or GCP_PROJECT env var"
        log_error "  - You haven't created a GCP project yet"
        log_error ""
        log_error "How to fix:"
        log_error "  1. List your existing projects:"
        log_error "     ${CYAN}gcloud projects list${NC}"
        log_error ""
        log_error "  2. Set a project via environment variable:"
        log_error "     ${CYAN}export GCP_PROJECT=your-project-id${NC}"
        log_error ""
        log_error "  3. Or set via gcloud config:"
        log_error "     ${CYAN}gcloud config set project YOUR_PROJECT_ID${NC}"
        log_error ""
        log_error "  4. Don't have a project? Create one:"
        log_error "     ${CYAN}https://console.cloud.google.com/projectcreate${NC}"
        log_error ""
        log_error "  5. Enable Compute Engine API for your project:"
        log_error "     ${CYAN}https://console.cloud.google.com/apis/library/compute.googleapis.com${NC}"
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

verify_server_connectivity() { ssh_verify_connectivity "$@"; }

wait_for_cloud_init() {
    local ip="${1}" max_attempts=${2:-60}

    # First establish SSH connectivity
    ssh_verify_connectivity "${ip}" 30 5

    # Then wait for startup script completion marker
    generic_ssh_wait "${SSH_USER}" "${ip}" "$SSH_OPTS -o ConnectTimeout=5" "test -f /tmp/.cloud-init-complete" "startup script completion" "${max_attempts}" 5
}

# Standard SSH operations (delegates to shared helpers in shared/common.sh)
# GCP uses current username via SSH_USER set above
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

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

# ============================================================
# Auto-initialization
# ============================================================

# Register cleanup trap for temporary files used by this provider
# This ensures temp files created by track_temp_file() are cleaned up on exit
register_cleanup_trap
