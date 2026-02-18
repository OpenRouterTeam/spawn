#!/bin/bash
# Common bash functions for Daytona sandbox spawn scripts
# Uses Daytona CLI (daytona) — https://www.daytona.io
# Sandboxes are cloud dev environments with true SSH access
# Default: --class small (override with DAYTONA_CLASS or explicit DAYTONA_CPU/MEMORY/DISK)

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
# Daytona specific functions
# ============================================================

SPAWN_DASHBOARD_URL="https://app.daytona.io/"

ensure_daytona_cli() {
    if ! command -v daytona &>/dev/null; then
        log_step "Installing Daytona CLI..."
        if command -v brew &>/dev/null; then
            brew install daytonaio/cli/daytona 2>/dev/null || {
                log_error "Failed to install Daytona CLI via Homebrew"
                log_error "Install manually: brew install daytonaio/cli/daytona"
                return 1
            }
        else
            log_error "Daytona CLI not found and Homebrew is not available"
            log_error "Install manually: brew install daytonaio/cli/daytona"
            log_error "See: https://www.daytona.io/docs/en/getting-started"
            return 1
        fi
    fi
    log_info "Daytona CLI available"
}

_is_daytona_auth_error() {
    printf '%s' "${1}" | grep -qi "unauthorized\|invalid.*key\|authentication\|forbidden"
}

_daytona_auth_error() {
    log_error "Invalid API key"
    log_error "How to fix:"
    log_warn "  1. Verify API key at: https://app.daytona.io"
    log_warn "  2. Ensure the key has sandbox permissions"
    log_warn "  3. Check key hasn't expired or been revoked"
}

test_daytona_token() {
    local test_response
    # Authenticate CLI with the API key first
    test_response=$(daytona login --api-key "${DAYTONA_API_KEY}" 2>&1)
    local exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        if _is_daytona_auth_error "${test_response}"; then
            _daytona_auth_error; return 1
        fi
        log_error "Daytona login failed: ${test_response}"
        return 1
    fi

    # Verify by listing sandboxes (lightweight API call)
    test_response=$(daytona list --limit 1 2>&1)
    if [[ $? -ne 0 ]] && _is_daytona_auth_error "${test_response}"; then
        _daytona_auth_error; return 1
    fi
    return 0
}

ensure_daytona_token() {
    ensure_api_token_with_provider \
        "Daytona" \
        "DAYTONA_API_KEY" \
        "${HOME}/.config/spawn/daytona.json" \
        "https://app.daytona.io" \
        "test_daytona_token"
}

get_server_name() {
    get_resource_name "DAYTONA_SANDBOX_NAME" "Enter sandbox name: "
}

_is_snapshot_conflict() {
    printf '%s' "${1}" | grep -qi "cannot specify.*resources.*snapshot\|cannot specify.*sandbox.*resources"
}

_daytona_create_with_resources() {
    local name="${1}"
    local cpu="${DAYTONA_CPU:-2}"
    local memory="${DAYTONA_MEMORY:-2048}"
    local disk="${DAYTONA_DISK:-5}"

    # Validate numeric env vars to prevent command injection
    if [[ ! "${cpu}" =~ ^[0-9]+$ ]]; then log_error "Invalid DAYTONA_CPU: must be numeric"; return 1; fi
    if [[ ! "${memory}" =~ ^[0-9]+$ ]]; then log_error "Invalid DAYTONA_MEMORY: must be numeric"; return 1; fi
    if [[ ! "${disk}" =~ ^[0-9]+$ ]]; then log_error "Invalid DAYTONA_DISK: must be numeric"; return 1; fi

    log_step "Creating Daytona sandbox '${name}' (${cpu} vCPU / ${memory}MB RAM / ${disk}GB disk)..."
    daytona create \
        --name "${name}" \
        --cpu "${cpu}" \
        --memory "${memory}" \
        --disk "${disk}" \
        --auto-stop 0 \
        --auto-archive 0 \
        2>&1
}

_daytona_create_with_class() {
    local name="${1}"
    local sandbox_class="${DAYTONA_CLASS:-small}"

    # Validate class to prevent injection (alphanumeric, hyphens, underscores)
    if [[ ! "${sandbox_class}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid DAYTONA_CLASS: must be alphanumeric (with hyphens/underscores)"
        return 1
    fi

    log_step "Creating Daytona sandbox '${name}' (class: ${sandbox_class})..."
    daytona create \
        --name "${name}" \
        --class "${sandbox_class}" \
        --auto-stop 0 \
        --auto-archive 0 \
        2>&1
}

_resolve_sandbox_id() {
    local name="${1}"

    # Try to get the sandbox ID from `daytona info`
    local info_output
    info_output=$(daytona info "${name}" --format json 2>/dev/null) || true

    if [[ -n "${info_output}" ]]; then
        DAYTONA_SANDBOX_ID=$(printf '%s' "${info_output}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || true
    fi

    # Fall back to using the name as the identifier (Daytona accepts both)
    if [[ -z "${DAYTONA_SANDBOX_ID:-}" ]]; then
        DAYTONA_SANDBOX_ID="${name}"
    fi

    export DAYTONA_SANDBOX_ID
    export DAYTONA_SANDBOX_NAME_ACTUAL="${name}"
}

create_server() {
    local name="${1}"
    local output
    local exit_code=0

    # Try explicit resources first if any resource env vars are set
    if [[ -n "${DAYTONA_CPU:-}" || -n "${DAYTONA_MEMORY:-}" || -n "${DAYTONA_DISK:-}" ]]; then
        output=$(_daytona_create_with_resources "${name}") && exit_code=0 || exit_code=$?

        # Detect snapshot/resource conflict and fall back to --class
        if [[ ${exit_code} -ne 0 ]] && _is_snapshot_conflict "${output}"; then
            log_warn "Daytona rejected explicit resource flags (snapshot in use)"
            log_step "Retrying with --class small..."
            output=$(_daytona_create_with_class "${name}") && exit_code=0 || exit_code=$?
        fi
    else
        output=$(_daytona_create_with_class "${name}") && exit_code=0 || exit_code=$?
    fi

    if [[ ${exit_code} -ne 0 ]]; then
        if _is_snapshot_conflict "${output}"; then
            log_error "Cannot specify resources when using a Daytona snapshot"
            log_error ""
            log_error "Use a sandbox class instead:"
            log_error "  DAYTONA_CLASS=small spawn <agent> daytona"
            log_error ""
            log_error "Or unset explicit resource variables:"
            log_error "  unset DAYTONA_CPU DAYTONA_MEMORY DAYTONA_DISK"
        else
            log_error "Failed to create sandbox: ${output}"
        fi
        return 1
    fi

    _resolve_sandbox_id "${name}"
    log_info "Sandbox created: ${DAYTONA_SANDBOX_ID}"

    save_vm_connection "daytona-sandbox" "daytona" "${DAYTONA_SANDBOX_ID}" "$name" "daytona"
}

wait_for_cloud_init() {
    log_step "Installing base tools in sandbox..."
    run_server "apt-get update -y && apt-get install -y curl unzip git zsh" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# Daytona uses `daytona exec` for running commands in sandboxes
# SECURITY: Uses printf %q to properly escape commands to prevent injection
run_server() {
    local cmd="${1}"
    local escaped_cmd
    escaped_cmd=$(printf '%q' "${cmd}")
    daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "${escaped_cmd}"
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    # base64 output is safe (alphanumeric + /+=) so no injection risk
    local content
    content=$(base64 -w0 < "${local_path}" 2>/dev/null || base64 < "${local_path}")

    daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Daytona has true SSH support — much better than exec-only providers
interactive_session() {
    local cmd="${1}"
    local session_exit=0
    if [[ -z "${cmd}" ]]; then
        # Pure interactive shell via SSH
        daytona ssh "${DAYTONA_SANDBOX_ID}" || session_exit=$?
    else
        # Run a specific command interactively via exec
        # SECURITY: Properly escape command
        local escaped_cmd
        escaped_cmd=$(printf '%q' "${cmd}")
        daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "${escaped_cmd}" || session_exit=$?
    fi
    SERVER_NAME="${DAYTONA_SANDBOX_ID:-}" SPAWN_RECONNECT_CMD="daytona ssh ${DAYTONA_SANDBOX_ID:-}" \
        _show_exec_post_session_summary
    return "${session_exit}"
}

destroy_server() {
    local sandbox_id="${1:-${DAYTONA_SANDBOX_ID:-}}"
    if [[ -z "${sandbox_id}" ]]; then
        log_warn "No sandbox ID to destroy"
        return 0
    fi
    log_step "Destroying sandbox ${sandbox_id}..."
    daytona delete "${sandbox_id}" 2>/dev/null || true
    log_info "Sandbox destroyed"
}

list_servers() {
    daytona list
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { ensure_daytona_cli; ensure_daytona_token; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { wait_for_cloud_init; }
cloud_run() { run_server "$1"; }
cloud_upload() { upload_file "$1" "$2"; }
cloud_interactive() { interactive_session "$1"; }
cloud_label() { echo "Daytona sandbox"; }
