#!/bin/bash
# Common bash functions for CodeSandbox spawn scripts
# Uses CodeSandbox SDK + CLI — https://codesandbox.io
# Sandboxes are Firecracker microVMs with ~2 second start times
# No SSH — uses CodeSandbox SDK for exec

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
# CodeSandbox specific functions
# ============================================================

ensure_codesandbox_cli() {
    if ! command -v node &>/dev/null; then
        log_step "Installing Node.js..."
        if command -v curl &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs 2>/dev/null || {
                log_error "Failed to install Node.js automatically"
                log_error ""
                log_error "Please install Node.js manually:"
                log_error "  Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash - && sudo apt-get install -y nodejs"
                log_error "  macOS:          brew install node"
                log_error "  Fedora/RHEL:    sudo dnf install nodejs"
                return 1
            }
        else
            log_error "Node.js is required but not installed"
            log_error "Install Node.js: https://nodejs.org/"
            return 1
        fi
    fi

    if ! npm list -g @codesandbox/sdk &>/dev/null; then
        log_step "Installing CodeSandbox SDK/CLI..."
        npm install -g @codesandbox/sdk 2>/dev/null || {
            log_error "Failed to install CodeSandbox SDK"
            log_error ""
            log_error "Manual installation:"
            log_error "  npm install -g @codesandbox/sdk"
            return 1
        }
    fi
    log_info "CodeSandbox SDK/CLI ready"
}

test_codesandbox_token() {
    # Test token by attempting to list sandboxes (lightweight API call)
    local test_output
    test_output=$(CSB_API_KEY="${CSB_API_KEY}" npx -y @codesandbox/sdk sandboxes list 2>&1)
    local exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        if echo "${test_output}" | grep -qi "unauthorized\|invalid.*key\|authentication\|401"; then
            log_error "Invalid API key"
            log_warn "Remediation steps:"
            log_warn "  1. Get a new API key at: https://codesandbox.io/t/api"
            log_warn "  2. Enable all scopes when creating the key"
            log_warn "  3. Export it as: export CSB_API_KEY=your-key-here"
            return 1
        fi
    fi
    return 0
}

ensure_codesandbox_token() {
    ensure_api_token_with_provider \
        "CodeSandbox" \
        "CSB_API_KEY" \
        "${HOME}/.config/spawn/codesandbox.json" \
        "https://codesandbox.io/t/api" \
        "test_codesandbox_token"
}

get_server_name() {
    get_resource_name "CODESANDBOX_SANDBOX_NAME" "Enter sandbox name: "
}

# Run a JS snippet that uses the CodeSandbox SDK.
# The snippet receives `sdk` (authenticated SDK instance) in scope.
# All extra env vars are forwarded so callers can pass data safely.
# Usage: _csb_sdk_eval 'await sdk.sandboxes.list()'
_csb_sdk_eval() {
    local js_body="${1}"
    node -e "
const { CodeSandbox } = require('@codesandbox/sdk');
const sdk = new CodeSandbox(process.env.CSB_API_KEY);
(async () => {
    try { ${js_body} }
    catch (e) { console.error('ERROR:', e.message); process.exit(1); }
})();
"
}

# Connect to an existing sandbox, run a command, stream output.
# Receives sandbox ID via _CSB_SB_ID env var, command via _CSB_CMD.
_csb_run_cmd() {
    _csb_sdk_eval "
        const sb = await sdk.sandboxes.get(process.env._CSB_SB_ID);
        const c = await sb.connect();
        const r = await c.commands.run(process.env._CSB_CMD);
        if (r.output) process.stdout.write(r.output);
        if (r.stderr) process.stderr.write(r.stderr);
        process.exit(r.exitCode || 0);
    "
}

# Invoke Node.js script to create sandbox via SDK
# SECURITY: Pass name and template via environment variables to prevent injection
_invoke_codesandbox_create() {
    local name="${1}"
    local template="${2:-base}"

    CSB_API_KEY="${CSB_API_KEY}" _CSB_NAME="${name}" _CSB_TEMPLATE="${template}" \
        _csb_sdk_eval "
            const sb = await sdk.sandboxes.create({
                name: process.env._CSB_NAME,
                template: process.env._CSB_TEMPLATE || 'base'
            });
            console.log(sb.id);
        " 2>&1
}

create_server() {
    local name="${1}"
    local template="${CODESANDBOX_TEMPLATE:-base}"

    log_step "Creating CodeSandbox sandbox '${name}'..."

    local output
    output=$(_invoke_codesandbox_create "${name}" "${template}")
    local exit_code=$?

    if [[ ${exit_code} -ne 0 ]] || [[ -z "${output}" ]] || [[ "${output}" =~ ERROR ]]; then
        log_error "Failed to create sandbox"
        log_error ""
        if [[ -n "${output}" ]]; then
            log_error "Error details: ${output}"
        fi
        log_error ""
        log_error "Possible causes:"
        log_error "  - Invalid API key or expired authentication"
        log_error "  - Insufficient quota or credits (check: https://codesandbox.io/settings)"
        log_error "  - Network connectivity issues"
        log_error "  - Invalid sandbox name or template"
        return 1
    fi

    CODESANDBOX_SANDBOX_ID="${output}"
    export CODESANDBOX_SANDBOX_ID
    log_info "Sandbox created: ID=${CODESANDBOX_SANDBOX_ID}"
}

wait_for_cloud_init() {
    log_step "Installing tools in sandbox..."
    # CodeSandbox comes with Node.js pre-installed
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\${HOME}/.bun/bin:\${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    log_info "Tools installed"
}

# Validate CodeSandbox sandbox ID format
validate_sandbox_id() {
    local sid="${1}"
    if [[ ! "${sid}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid CODESANDBOX_SANDBOX_ID format: expected alphanumeric with dashes/underscores"
        return 1
    fi
}

# Execute command via CodeSandbox SDK
run_server() {
    local cmd="${1}"
    validate_sandbox_id "${CODESANDBOX_SANDBOX_ID}" || return 1

    # SECURITY: Pass sandbox ID and command via environment variables to prevent injection
    CSB_API_KEY="${CSB_API_KEY}" _CSB_SB_ID="${CODESANDBOX_SANDBOX_ID}" _CSB_CMD="${cmd}" _csb_run_cmd
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"

    # Validate remote_path to prevent command injection
    if [[ "$remote_path" == *"'"* || "$remote_path" == *'$'* || "$remote_path" == *'`'* || "$remote_path" == *$'\n'* ]]; then
        log_error "Invalid remote path (contains unsafe characters): $remote_path"
        return 1
    fi

    local content
    content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")

    # SECURITY: Properly escape remote_path to prevent injection
    local escaped_path
    escaped_path=$(printf '%q' "${remote_path}")
    # base64 output is safe (alphanumeric + /+=) so no injection risk
    run_server "printf '%s' '${content}' | base64 -d > ${escaped_path}"
}

interactive_session() {
    log_info "Starting interactive session..."
    log_warn "Note: Use 'csb' CLI dashboard for full terminal experience"
    run_server "$1"
}

destroy_server() {
    local sandbox_id="${1:-${CODESANDBOX_SANDBOX_ID}}"
    validate_sandbox_id "${sandbox_id}" || return 1
    log_step "Shutting down sandbox..."

    # SECURITY: Pass sandbox ID via environment variable
    CSB_API_KEY="${CSB_API_KEY}" _CSB_SB_ID="${sandbox_id}" \
        _csb_sdk_eval "
            await sdk.sandboxes.shutdown(process.env._CSB_SB_ID);
            console.log('Sandbox shut down');
        " 2>/dev/null || true
    log_info "Sandbox shut down"
}

list_servers() {
    CSB_API_KEY="${CSB_API_KEY}" \
        _csb_sdk_eval "
            const sbs = await sdk.sandboxes.list();
            sbs.forEach(sb => console.log(sb.id + '  ' + (sb.name || 'unnamed')));
        " 2>/dev/null || echo "No sandboxes found"
}
