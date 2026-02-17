#!/bin/bash
set -eo pipefail
# Common bash functions for local machine spawn scripts
# No cloud provisioning — runs agents directly on the user's machine

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
# Local machine functions
# ============================================================

# No authentication needed for local machine
ensure_local_ready() {
    log_info "Running on local machine"

    # Ensure basic tools are available
    if ! command -v curl &>/dev/null; then
        log_error "curl is required but not installed"
        return 1
    fi

    check_python_available || return 1
}

# No server name needed — use hostname
get_server_name() {
    local name
    name=$(hostname 2>/dev/null || echo "local")
    echo "${name}"
}

# No server creation — it's the local machine
create_server() {
    local name="${1}"
    log_info "Using local machine: ${name}"
}

# No cloud-init needed
wait_for_cloud_init() {
    :
}

# Run a command locally
# The command string is passed directly to bash -c for shell parsing.
# All callers pass trusted, hardcoded command strings (not user input).
run_server() {
    local cmd="${1}"
    bash -c "${cmd}"
}

# Copy a file locally
upload_file() {
    local local_path="${1}"
    local remote_path="${2}"
    # Expand ~ in remote_path
    local expanded_path="${remote_path/#\~/$HOME}"
    mkdir -p "$(dirname "${expanded_path}")"
    cp "${local_path}" "${expanded_path}"
}

# Start an interactive session locally
interactive_session() {
    local cmd="${1}"
    bash -c "${cmd}"
}

# No server to destroy
destroy_server() {
    log_info "Nothing to destroy (local machine)"
}

# No servers to list
list_servers() {
    printf '%s\n' "$(hostname 2>/dev/null || echo "local")"
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_local_ready; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { :; }
cloud_run() { run_server "$1"; }
cloud_upload() { upload_file "$1" "$2"; }
cloud_interactive() { bash -c "$1"; }
cloud_label() { echo "local machine"; }
