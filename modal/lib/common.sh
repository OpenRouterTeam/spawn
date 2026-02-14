#!/bin/bash
# Common bash functions for Modal sandbox spawn scripts
# Uses Modal CLI + Python SDK — https://modal.com
# Sandboxes are secure containers with sub-second cold starts
# No SSH — uses `modal sandbox exec` for commands

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
# Modal specific functions
# ============================================================

SPAWN_DASHBOARD_URL="https://modal.com/apps"

ensure_modal_cli() {
    # Check Python 3 is available (required for Modal Python SDK)
    check_python_available || return 1

    if ! command -v modal &>/dev/null; then
        log_step "Installing Modal CLI..."
        if ! pip install modal 2>/dev/null && ! pip3 install modal 2>/dev/null; then
            log_error "Failed to install Modal CLI"
            log_error ""
            log_error "Possible causes:"
            log_error "  - pip/pip3 not installed (install: apt-get install python3-pip or brew install python3)"
            log_error "  - Insufficient permissions (try: pip3 install --user modal)"
            log_error "  - Network connectivity issues"
            log_error ""
            log_error "Manual installation:"
            log_error "  pip3 install --user modal"
            log_error "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            return 1
        fi
    fi
    # Check if authenticated
    if ! modal profile current &>/dev/null; then
        log_step "Modal not authenticated. Running setup..."
        modal setup
    fi
    log_info "Modal CLI ready"
}

get_server_name() {
    get_resource_name "MODAL_SANDBOX_NAME" "Enter sandbox name: "
}

# Validate Modal sandbox creation parameters
# Usage: _validate_modal_params NAME IMAGE
_validate_modal_params() {
    local name="${1}" image="${2}"

    # Validate image name - used as Python attribute name (e.g. modal.Image.debian_slim())
    if [[ ! "${image}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        log_error "Invalid MODAL_IMAGE: must be a valid Python identifier (letters, digits, underscores)"
        return 1
    fi

    # Validate sandbox name - alphanumeric and dashes only
    if [[ ! "${name}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
        log_error "Invalid sandbox name: must be alphanumeric with dashes/underscores"
        return 1
    fi
}

# Invoke Modal Python SDK to create a sandbox, prints sandbox object_id to stdout
# SECURITY: Pass name via environment variable to prevent Python injection
# Usage: _invoke_modal_create NAME IMAGE
_invoke_modal_create() {
    _MODAL_NAME="${1}" _MODAL_IMAGE="${2}" python3 -c "
import modal, sys, os
try:
    name = os.environ['_MODAL_NAME']
    image_name = os.environ['_MODAL_IMAGE']
    app = modal.App.lookup('spawn-' + name, create_if_missing=True)
    image_fn = getattr(modal.Image, image_name)
    sb = modal.Sandbox.create(
        app=app,
        name=name,
        image=image_fn().apt_install('curl', 'unzip', 'git', 'zsh'),
        timeout=3600,
    )
    print(sb.object_id)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1
}

# Report Modal sandbox creation failure with troubleshooting guidance
_report_modal_create_error() {
    local name="${1}" output="${2}"
    log_error "Failed to create Modal sandbox '${name}'"
    log_error ""
    if [[ -n "${output}" ]]; then
        log_error "Error details: ${output}"
    fi
    log_error ""
    log_error "Possible causes:"
    log_error "  - Modal authentication expired (run: modal setup)"
    log_error "  - Insufficient quota or credits (check: https://modal.com/settings)"
    log_error "  - Network connectivity issues"
    log_error "  - Invalid sandbox name (must be alphanumeric with dashes)"
    log_error ""
    log_error "How to fix:"
    log_error "  1. Re-authenticate: modal setup"
    log_error "  2. Verify account status: https://modal.com/settings"
    log_error "  3. Check Modal status: https://status.modal.com"
}

create_server() {
    local name="${1}"
    local image="${MODAL_IMAGE:-debian_slim}"

    _validate_modal_params "${name}" "${image}" || return 1

    log_step "Creating Modal sandbox '${name}'..."

    local create_output create_exitcode
    create_output=$(_invoke_modal_create "${name}" "${image}")
    create_exitcode=$?

    if [[ ${create_exitcode} -ne 0 ]] || [[ -z "${create_output}" ]] || [[ "${create_output}" =~ ERROR ]]; then
        _report_modal_create_error "${name}" "${create_output}"
        return 1
    fi

    MODAL_SANDBOX_ID="${create_output}"
    export MODAL_SANDBOX_ID
    export MODAL_APP_NAME="spawn-${name}"
    export MODAL_SANDBOX_NAME_ACTUAL="${name}"
    log_info "Sandbox created: ID=${MODAL_SANDBOX_ID}"
}

wait_for_cloud_init() {
    log_step "Installing tools in sandbox..."
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Tools installed"
}

# Validate Modal sandbox ID format (sb-XXXXX)
validate_sandbox_id() {
    local sid="${1}"
    if [[ ! "${sid}" =~ ^sb-[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid MODAL_SANDBOX_ID format: expected sb-<alphanumeric>"
        return 1
    fi
}

# Modal uses Python SDK for exec
run_server() {
    local cmd="${1}"
    validate_sandbox_id "${MODAL_SANDBOX_ID}" || return 1
    # SECURITY: Pass sandbox ID and command via environment variables to prevent Python injection
    _MODAL_SB_ID="${MODAL_SANDBOX_ID}" _MODAL_CMD="${cmd}" python3 -c "
import modal, os, sys
sb = modal.Sandbox.from_id(os.environ['_MODAL_SB_ID'])
p = sb.exec('bash', '-c', os.environ['_MODAL_CMD'])
print(p.stdout.read(), end='')
if p.stderr.read():
    print(p.stderr.read(), end='', file=sys.stderr)
p.wait()
"
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    local content
    content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")
    # base64 output is safe (alphanumeric + /+=) so no injection risk
    run_server "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

interactive_session() {
    local cmd="${1}"
    validate_sandbox_id "${MODAL_SANDBOX_ID}" || return 1
    # SECURITY: Pass sandbox ID and command via environment variables to prevent Python injection
    local session_exit=0
    _MODAL_SB_ID="${MODAL_SANDBOX_ID}" _MODAL_CMD="${cmd}" python3 -c "
import modal, sys, os
sb = modal.Sandbox.from_id(os.environ['_MODAL_SB_ID'])
p = sb.exec('bash', '-c', os.environ['_MODAL_CMD'], pty=True)
for line in p.stdout:
    print(line, end='')
p.wait()
" || session_exit=$?
    SERVER_NAME="${MODAL_SANDBOX_ID:-}" _show_exec_post_session_summary
    return "${session_exit}"
}

destroy_server() {
    local sandbox_id="${1:-${MODAL_SANDBOX_ID}}"
    validate_sandbox_id "${sandbox_id}" || return 1
    log_step "Terminating sandbox..."
    # SECURITY: Pass sandbox ID via environment variable to prevent Python injection
    _MODAL_SB_ID="${sandbox_id}" python3 -c "
import modal, os
sb = modal.Sandbox.from_id(os.environ['_MODAL_SB_ID'])
sb.terminate()
" 2>/dev/null || true
    log_info "Sandbox terminated"
}

list_servers() {
    python3 -c "
import modal
for sb in modal.Sandbox.list():
    print(f'{sb.object_id}  {sb.name or \"unnamed\"}')" 2>/dev/null || echo "No sandboxes found"
}
