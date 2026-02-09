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

ensure_modal_cli() {
    # Check Python 3 is available (required for Modal Python SDK)
    check_python_available || return 1

    if ! command -v modal &>/dev/null; then
        log_warn "Installing Modal CLI..."
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
        log_warn "Modal not authenticated. Running setup..."
        modal setup
    fi
    log_info "Modal CLI ready"
}

get_server_name() {
    get_resource_name "MODAL_SANDBOX_NAME" "Enter sandbox name: "
}

create_server() {
    local name="${1}"
    local image="${MODAL_IMAGE:-debian_slim}"

    log_warn "Creating Modal sandbox '${name}'..."

    # Capture both stdout and stderr from Python SDK
    local create_output
    local create_exitcode
    create_output=$(python3 -c "
import modal, sys
try:
    app = modal.App.lookup('spawn-${name}', create_if_missing=True)
    sb = modal.Sandbox.create(
        app=app,
        name='${name}',
        image=modal.Image.${image}().apt_install('curl', 'unzip', 'git', 'zsh'),
        timeout=3600,
    )
    print(sb.object_id)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1)
    create_exitcode=$?

    if [[ ${create_exitcode} -ne 0 ]] || [[ -z "${create_output}" ]] || [[ "${create_output}" =~ ERROR ]]; then
        log_error "Failed to create Modal sandbox '${name}'"
        log_error ""
        if [[ -n "${create_output}" ]]; then
            log_error "Error details: ${create_output}"
        fi
        log_error ""
        log_error "Possible causes:"
        log_error "  - Modal authentication expired (run: modal setup)"
        log_error "  - Insufficient quota or credits (check: https://modal.com/settings)"
        log_error "  - Network connectivity issues"
        log_error "  - Invalid sandbox name (must be alphanumeric with dashes)"
        log_error ""
        log_error "Troubleshooting:"
        log_error "  1. Re-authenticate: modal setup"
        log_error "  2. Verify account status: https://modal.com/settings"
        log_error "  3. Check Modal status: https://status.modal.com"
        return 1
    fi

    MODAL_SANDBOX_ID="${create_output}"
    export MODAL_SANDBOX_ID
    export MODAL_APP_NAME="spawn-${name}"
    export MODAL_SANDBOX_NAME_ACTUAL="${name}"
    log_info "Sandbox created: ID=${MODAL_SANDBOX_ID}"
}

wait_for_cloud_init() {
    log_warn "Installing tools in sandbox..."
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Tools installed"
}

# Modal uses Python SDK for exec
run_server() {
    local cmd="${1}"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "${cmd}")
    python3 -c "
import modal, shlex
sb = modal.Sandbox.from_id('${MODAL_SANDBOX_ID}')
p = sb.exec('bash', '-c', ${escaped_cmd})
print(p.stdout.read(), end='')
if p.stderr.read():
    import sys; print(p.stderr.read(), end='', file=sys.stderr)
p.wait()
"
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"
    local content
    content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")
    # SECURITY: Properly escape paths and content to prevent injection
    local escaped_path
    escaped_path=$(printf '%q' "${remote_path}")
    local escaped_content
    escaped_content=$(printf '%q' "${content}")
    run_server "echo ${escaped_content} | base64 -d > ${escaped_path}"
}

interactive_session() {
    local cmd="${1}"
    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "${cmd}")
    python3 -c "
import modal, sys
sb = modal.Sandbox.from_id('${MODAL_SANDBOX_ID}')
p = sb.exec('bash', '-c', ${escaped_cmd}, pty=True)
for line in p.stdout:
    print(line, end='')
p.wait()
"
}

destroy_server() {
    local sandbox_id="${1:-${MODAL_SANDBOX_ID}}"
    log_warn "Terminating sandbox..."
    python3 -c "
import modal
sb = modal.Sandbox.from_id('${sandbox_id}')
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
