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
        log_warn "No active Google Cloud account — launching gcloud auth login..."
        gcloud auth login || {
            log_error "Authentication failed. You can also set credentials via:"
            log_error "  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json"
            return 1
        }
    fi
}

# ============================================================
# Interactive pickers for GCP project, zone, and machine type
# ============================================================

# Curated list of popular GCP machine types (value\tLabel\tHint)
_gcp_machine_type_options() {
    printf '%s\n' \
        "e2-micro	e2-micro	Shared CPU · 2 vCPU · 1 GB RAM   (~\$7/mo)" \
        "e2-small	e2-small	Shared CPU · 2 vCPU · 2 GB RAM   (~\$14/mo)" \
        "e2-medium	e2-medium	Shared CPU · 2 vCPU · 4 GB RAM   (~\$28/mo)  ← default" \
        "e2-standard-2	e2-standard-2	2 vCPU · 8 GB RAM                (~\$49/mo)" \
        "e2-standard-4	e2-standard-4	4 vCPU · 16 GB RAM               (~\$98/mo)" \
        "n2-standard-2	n2-standard-2	2 vCPU · 8 GB RAM, higher perf   (~\$72/mo)" \
        "n2-standard-4	n2-standard-4	4 vCPU · 16 GB RAM, higher perf  (~\$144/mo)" \
        "c4-standard-2	c4-standard-2	2 vCPU · 8 GB RAM, latest gen    (~\$82/mo)"
}

# Curated list of popular GCP zones (value\tLabel\tHint)
_gcp_zone_options() {
    printf '%s\n' \
        "us-central1-a	us-central1-a	Iowa, US        ← default" \
        "us-east1-b	us-east1-b	South Carolina, US" \
        "us-east4-a	us-east4-a	N. Virginia, US" \
        "us-west1-a	us-west1-a	Oregon, US" \
        "us-west2-a	us-west2-a	Los Angeles, US" \
        "northamerica-northeast1-a	northamerica-northeast1-a	Montreal, Canada" \
        "europe-west1-b	europe-west1-b	Belgium" \
        "europe-west4-a	europe-west4-a	Netherlands" \
        "europe-west6-a	europe-west6-a	Zurich, Switzerland" \
        "asia-east1-a	asia-east1-a	Taiwan" \
        "asia-southeast1-a	asia-southeast1-a	Singapore" \
        "australia-southeast1-a	australia-southeast1-a	Sydney, Australia"
}

# Fetch active GCP projects accessible to the authenticated user (value\tLabel\tHint)
_gcp_project_options() {
    gcloud projects list \
        --filter="lifecycleState=ACTIVE" \
        --format="value(projectId,name)" \
        2>/dev/null | \
    awk -F'\t' '{ print $1 "\t" $1 "\t" $2 }'
}

# Generic GCP interactive picker.
# Respects the named env var (skip picker if already set).
# Tries `spawn pick` for a nice arrow-key UI, falls back to a numbered list.
#
# Usage: _gcp_interactive_pick DISPLAY_NAME ENV_VAR_NAME DEFAULT OPTIONS_FN
# Outputs the selected value on stdout.
_gcp_interactive_pick() {
    local display="${1}"     # e.g. "GCP machine type"
    local env_var="${2}"     # e.g. "GCP_MACHINE_TYPE"
    local default_val="${3}" # e.g. "e2-medium"
    local options_fn="${4}"  # function name that prints "value\tLabel\tHint" lines

    # Honour an explicit env var override — no prompt needed
    local current_val
    current_val="${!env_var:-}"
    if [[ -n "${current_val}" ]]; then
        echo "${current_val}"
        return
    fi

    # Fetch available options
    local options_text
    options_text=$("${options_fn}")
    if [[ -z "${options_text}" ]]; then
        log_warn "Could not list ${display} options — using default: ${default_val}"
        echo "${default_val}"
        return
    fi

    # Try `spawn pick` for a nicer arrow-key UI (available when user ran `spawn`)
    if command -v spawn >/dev/null 2>&1; then
        local picked
        picked=$(printf '%s\n' "${options_text}" | \
            spawn pick --prompt "Select ${display}" --default "${default_val}" 2>/dev/tty) && {
            echo "${picked}"
            return
        }
    fi

    # Fallback: shared/common.sh numbered-list selector
    # Convert "value\tLabel\tHint" → "value|Label" for _display_and_select
    local items
    items=$(printf '%s\n' "${options_text}" | awk -F'\t' '{ print $1 "|" $2 }')
    _display_and_select "${display}" "${default_val}" "${default_val}" <<< "${items}"
}

_gcp_pick_machine_type() {
    _gcp_interactive_pick "GCP machine type" "GCP_MACHINE_TYPE" "e2-medium" "_gcp_machine_type_options"
}

_gcp_pick_zone() {
    _gcp_interactive_pick "GCP zone" "GCP_ZONE" "us-central1-a" "_gcp_zone_options"
}

_gcp_pick_project() {
    _gcp_interactive_pick "GCP project" "GCP_PROJECT" "" "_gcp_project_options"
}

# Resolve and export GCP_PROJECT — prompt interactively if not already set
_gcp_resolve_project() {
    # Check env var and gcloud config
    local project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
    if [[ "${project}" == "(unset)" ]]; then project=""; fi

    # If not set, offer an interactive project picker
    if [[ -z "${project}" ]]; then
        log_info "No GCP project configured — fetching your projects..."
        project=$(_gcp_pick_project)
    fi

    if [[ -z "${project}" ]]; then
        log_error "No GCP project selected"
        log_error ""
        log_error "Set one before retrying:"
        log_error "  export ${CYAN}GCP_PROJECT=your-project-id${NC}"
        log_error "  or: gcloud config set project YOUR_PROJECT_ID"
        log_error ""
        log_error "Don't have a project? Create one:"
        log_error "  ${CYAN}https://console.cloud.google.com/projectcreate${NC}"
        log_error ""
        log_error "Then enable Compute Engine API:"
        log_error "  ${CYAN}https://console.cloud.google.com/apis/library/compute.googleapis.com${NC}"
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
apt-get install -y curl unzip git zsh nodejs npm
# Upgrade Node.js to v22 LTS (apt has v18, agents like Cline need v20+)
# n installs to /usr/local/bin but apt's v18 at /usr/bin can shadow it, so symlink over
npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx
# Install Bun and Claude Code as the login user
GCP_USERNAME=$(logname 2>/dev/null || echo "${USER:-root}")
if [[ ! "$GCP_USERNAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "ERROR: Invalid username detected" >&2
    exit 1
fi
su - "$GCP_USERNAME" -c 'curl -fsSL https://bun.sh/install | bash' || true
su - "$GCP_USERNAME" -c 'curl -fsSL https://claude.ai/install.sh | bash' || true
# Configure npm global prefix so non-root user can npm install -g without sudo
su - "$GCP_USERNAME" -c 'mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global'
# Configure PATH for all users
echo 'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"' >> /etc/profile.d/spawn.sh
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

    local err_output
    err_output=$(cat "${gcloud_err}" 2>/dev/null)

    # Auto-reauth on expired tokens, then retry once
    if printf '%s' "${err_output}" | grep -qi "reauthentication\|refresh.*auth\|token.*expired\|credentials.*invalid"; then
        log_warn "Auth tokens expired — running gcloud auth login..."
        if gcloud auth login && gcloud config set project "${GCP_PROJECT}"; then
            log_info "Re-authenticated, retrying instance creation..."
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
            err_output=$(cat "${gcloud_err}" 2>/dev/null)
        fi
    fi

    log_error "Failed to create GCP instance"
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
    local image_family="ubuntu-2404-lts-amd64"
    local image_project="ubuntu-os-cloud"

    # Interactive pickers — each respects the env var override and skips the
    # prompt when GCP_MACHINE_TYPE / GCP_ZONE are already set.
    local machine_type zone
    machine_type=$(_gcp_pick_machine_type)
    zone=$(_gcp_pick_zone)

    # Validate to prevent command injection (covers both interactive and env-var paths)
    validate_resource_name "${machine_type}" || { log_error "Invalid GCP_MACHINE_TYPE: ${machine_type}"; return 1; }
    validate_region_name "${zone}" || { log_error "Invalid GCP_ZONE: ${zone}"; return 1; }

    # Export so downstream functions (cloud_wait_ready, destroy_server, etc.) see them
    export GCP_MACHINE_TYPE="${machine_type}"
    export GCP_ZONE="${zone}"

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

    save_vm_connection "${GCP_SERVER_IP}" "${SSH_USER:-$(whoami)}" "" "$name" "gcp" "{\"zone\":\"${zone}\",\"project\":\"${GCP_PROJECT}\"}"
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
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_gcloud; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${GCP_SERVER_IP}"; wait_for_cloud_init "${GCP_SERVER_IP}" 60; }
cloud_run() { run_server "${GCP_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${GCP_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${GCP_SERVER_IP}" "$1"; }
cloud_label() { echo "GCP instance"; }
