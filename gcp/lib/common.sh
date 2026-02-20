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
    if command -v gcloud &>/dev/null; then return 0; fi

    log_step "Installing Google Cloud SDK..."
    if [[ "$(uname)" == "Darwin" ]] && command -v brew &>/dev/null; then
        brew install --cask google-cloud-sdk \
            && log_info "Google Cloud SDK installed via Homebrew" \
            || {
                log_error "Auto-install failed. Install manually: brew install --cask google-cloud-sdk"
                return 1
            }
        # Homebrew cask puts gcloud in a non-standard location — source it
        local _gcloud_path
        for _gcloud_path in \
            "$(brew --prefix)/share/google-cloud-sdk/path.bash.inc" \
            "$(brew --prefix)/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/path.bash.inc"; do
            if [[ -f "${_gcloud_path}" ]]; then
                source "${_gcloud_path}"
                break
            fi
        done
    else
        # Linux / macOS without brew: use Google's installer
        local _gcp_tmp
        _gcp_tmp=$(mktemp -d)
        curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz" \
            -o "${_gcp_tmp}/gcloud.tar.gz" \
            && tar -xzf "${_gcp_tmp}/gcloud.tar.gz" -C "${HOME}" \
            && "${HOME}/google-cloud-sdk/install.sh" --quiet --path-update true \
            && export PATH="${HOME}/google-cloud-sdk/bin:${PATH}" \
            && rm -rf "${_gcp_tmp}" \
            && log_info "Google Cloud SDK installed" \
            || {
                rm -rf "${_gcp_tmp}"
                log_error "Auto-install failed. Install manually:"
                log_error "  https://cloud.google.com/sdk/docs/install"
                return 1
            }
    fi

    if ! command -v gcloud &>/dev/null; then
        log_error "gcloud not found after install. You may need to restart your shell."
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
# Spawn name → kebab-case conversion
# ============================================================

# Convert a display name to a valid GCP resource identifier (kebab-case).
# "My Dev Box" → "my-dev-box"   "Claude 2024!" → "claude-2024"
_to_kebab_case() {
    printf '%s' "${1}" \
        | tr '[:upper:]' '[:lower:]' \
        | sed 's/[^a-z0-9-]/-/g' \
        | sed 's/-\{2,\}/-/g' \
        | sed 's/^-//;s/-$//'
}

# Ask for a human-readable spawn name upfront, then derive a kebab-case
# default for GCP instance naming.  Respects SPAWN_NAME when already set
# (e.g. `spawn gcp claude --name "My Box"`).
# Exports: GCP_SPAWN_DISPLAY_NAME, GCP_INSTANCE_NAME_KEBAB
_gcp_prompt_spawn_name() {
    local display_name

    if [[ -n "${SPAWN_NAME:-}" ]]; then
        display_name="${SPAWN_NAME}"
        log_info "Spawn name: ${display_name}"
    else
        echo "" >&2
        display_name=$(safe_read "Spawn name (e.g. \"My Dev Box\"): ") || display_name=""
        [[ -z "${display_name}" ]] && display_name="spawn"
    fi

    local kebab
    kebab=$(_to_kebab_case "${display_name}")
    [[ -z "${kebab}" ]] && kebab="spawn"

    export GCP_SPAWN_DISPLAY_NAME="${display_name}"
    export GCP_INSTANCE_NAME_KEBAB="${kebab}"
    log_info "Instance name will default to: ${kebab}"
}

# ============================================================
# Interactive pickers for GCP project, zone, and machine type
# ============================================================

# Curated list of popular GCP machine types (id|detail)
_gcp_machine_type_options() {
    printf '%s\n' \
        "e2-micro|Shared CPU · 2 vCPU · 1 GB RAM (~\$7/mo)" \
        "e2-small|Shared CPU · 2 vCPU · 2 GB RAM (~\$14/mo)" \
        "e2-medium|Shared CPU · 2 vCPU · 4 GB RAM (~\$28/mo)" \
        "e2-standard-2|2 vCPU · 8 GB RAM (~\$49/mo)" \
        "e2-standard-4|4 vCPU · 16 GB RAM (~\$98/mo)" \
        "n2-standard-2|2 vCPU · 8 GB RAM, higher perf (~\$72/mo)" \
        "n2-standard-4|4 vCPU · 16 GB RAM, higher perf (~\$144/mo)" \
        "c4-standard-2|2 vCPU · 8 GB RAM, latest gen (~\$82/mo)"
}

# Curated list of popular GCP zones (id|location)
_gcp_zone_options() {
    printf '%s\n' \
        "us-central1-a|Iowa, US" \
        "us-east1-b|South Carolina, US" \
        "us-east4-a|N. Virginia, US" \
        "us-west1-a|Oregon, US" \
        "us-west2-a|Los Angeles, US" \
        "northamerica-northeast1-a|Montreal, Canada" \
        "europe-west1-b|Belgium" \
        "europe-west4-a|Netherlands" \
        "europe-west6-a|Zurich, Switzerland" \
        "asia-east1-a|Taiwan" \
        "asia-southeast1-a|Singapore" \
        "australia-southeast1-a|Sydney, Australia"
}

# Fetch active GCP projects accessible to the authenticated user (id|name)
_gcp_project_options() {
    gcloud projects list \
        --filter="lifecycleState=ACTIVE" \
        --format="value(projectId,name)" \
        2>/dev/null | \
    awk -F'\t' '{ print $1 "|" $2 }'
}

_gcp_pick_machine_type() {
    interactive_pick "GCP_MACHINE_TYPE" "e2-medium" "GCP machine types" _gcp_machine_type_options "e2-medium"
}

_gcp_pick_zone() {
    interactive_pick "GCP_ZONE" "us-central1-a" "GCP zones" _gcp_zone_options "us-central1-a"
}

_gcp_pick_project() {
    interactive_pick "GCP_PROJECT" "" "GCP projects" _gcp_project_options
}

# Resolve and export GCP_PROJECT — confirm existing or pick interactively
_gcp_resolve_project() {
    # Check env var and gcloud config
    local project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
    if [[ "${project}" == "(unset)" ]]; then project=""; fi

    # When a project is already set, ask whether to keep or change it
    if [[ -n "${project}" && "${SPAWN_NON_INTERACTIVE:-}" != "1" ]]; then
        log_info "Current GCP project: ${project}"
        local keep
        keep=$(safe_read "Keep this project? [Y/n]: ") || keep=""
        keep="${keep:-y}"
        if [[ "${keep}" =~ ^[nN] ]]; then
            project=""
        fi
    fi

    # If not set (or user chose to change), offer an interactive project picker
    if [[ -z "${project}" ]]; then
        log_info "Fetching your GCP projects..."
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
    # Honour an explicit env var override (non-interactive / CI)
    if [[ -n "${GCP_INSTANCE_NAME:-}" ]]; then
        echo "${GCP_INSTANCE_NAME}"
        return 0
    fi

    # Use the kebab-case spawn name as the default, shown in the prompt
    local default_name="${GCP_INSTANCE_NAME_KEBAB:-${SPAWN_NAME:-spawn}}"
    local name
    name=$(safe_read "Instance name [${default_name}]: ") || name=""
    [[ -z "${name}" ]] && name="${default_name}"

    if ! validate_server_name "${name}"; then
        return 1
    fi
    echo "${name}"
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

    local _zone_escaped _project_escaped
    _zone_escaped=$(json_escape "${zone}")
    _project_escaped=$(json_escape "${GCP_PROJECT}")
    save_vm_connection "${GCP_SERVER_IP}" "${SSH_USER:-$(whoami)}" "" "$name" "gcp" "{\"zone\":${_zone_escaped},\"project\":${_project_escaped}}"
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

cloud_authenticate() { _gcp_prompt_spawn_name; ensure_gcloud; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${GCP_SERVER_IP}"; wait_for_cloud_init "${GCP_SERVER_IP}" 60; }
cloud_run() { run_server "${GCP_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${GCP_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${GCP_SERVER_IP}" "$1"; }
cloud_label() { echo "GCP instance"; }
