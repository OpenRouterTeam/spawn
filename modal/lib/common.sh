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
    if ! command -v modal &>/dev/null; then
        log_warn "Installing Modal CLI..."
        pip install modal 2>/dev/null || pip3 install modal || {
            log_error "Failed to install Modal. Install manually: pip install modal"
            return 1
        }
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

    # Create sandbox via Python SDK (Modal CLI doesn't have direct sandbox create)
    MODAL_SANDBOX_ID=$(python3 -c "
import modal
app = modal.App.lookup('spawn-${name}', create_if_missing=True)
sb = modal.Sandbox.create(
    app=app,
    name='${name}',
    image=modal.Image.${image}().apt_install('curl', 'unzip', 'git', 'zsh'),
    timeout=3600,
)
print(sb.object_id)
" 2>/dev/null)

    if [[ -z "${MODAL_SANDBOX_ID}" ]]; then
        log_error "Failed to create Modal sandbox"
        return 1
    fi

    export MODAL_SANDBOX_ID
    export MODAL_APP_NAME="spawn-${name}"
    export MODAL_SANDBOX_NAME_ACTUAL="${name}"
    log_info "Sandbox created: ID=${MODAL_SANDBOX_ID}"
}

wait_for_cloud_init() {
    log_warn "Installing tools in sandbox..."
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Tools installed"
}

# Modal uses Python SDK for exec
run_server() {
    local cmd="${1}"
    python3 -c "
import modal
sb = modal.Sandbox.from_id('${MODAL_SANDBOX_ID}')
p = sb.exec('bash', '-c', '''${cmd}''')
print(p.stdout.read(), end='')
if p.stderr.read():
    import sys; print(p.stderr.read(), end='', file=sys.stderr)
p.wait()
"
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"
    local content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")
    run_server "echo '${content}' | base64 -d > '${remote_path}'"
}

interactive_session() {
    local cmd="${1}"
    python3 -c "
import modal, sys
sb = modal.Sandbox.from_id('${MODAL_SANDBOX_ID}')
p = sb.exec('bash', '-c', '''${cmd}''', pty=True)
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
