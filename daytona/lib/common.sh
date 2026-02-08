#!/bin/bash
# Common bash functions for Daytona sandbox spawn scripts
# Uses Daytona CLI (daytona) — https://www.daytona.io
# Sandboxes are cloud dev environments with true SSH access
# Default: 1 vCPU / 1GB RAM / 3GB disk (max: 4 vCPU / 8GB / 10GB)

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

ensure_daytona_cli() {
    if ! command -v daytona &>/dev/null; then
        log_warn "Installing Daytona CLI..."
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

test_daytona_token() {
    local test_response
    # Authenticate CLI with the API key first
    test_response=$(daytona login --api-key "${DAYTONA_API_KEY}" 2>&1)
    local exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        if printf '%s' "${test_response}" | grep -qi "unauthorized\|invalid.*key\|authentication\|forbidden"; then
            log_error "Invalid API key"
            log_warn "Remediation steps:"
            log_warn "  1. Verify API key at: https://app.daytona.io"
            log_warn "  2. Ensure the key has sandbox permissions"
            log_warn "  3. Check key hasn't expired or been revoked"
            return 1
        fi
        # Non-auth error during login — could be network, still fail
        log_error "Daytona login failed: ${test_response}"
        return 1
    fi

    # Verify by listing sandboxes (lightweight API call)
    test_response=$(daytona list --limit 1 2>&1)
    exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        if printf '%s' "${test_response}" | grep -qi "unauthorized\|invalid.*key\|authentication\|forbidden"; then
            log_error "Invalid API key"
            log_warn "Remediation steps:"
            log_warn "  1. Verify API key at: https://app.daytona.io"
            log_warn "  2. Ensure the key has sandbox permissions"
            log_warn "  3. Check key hasn't expired or been revoked"
            return 1
        fi
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

create_server() {
    local name="${1}"
    local cpu="${DAYTONA_CPU:-2}"
    local memory="${DAYTONA_MEMORY:-2048}"
    local disk="${DAYTONA_DISK:-5}"

    log_warn "Creating Daytona sandbox '${name}' (${cpu} vCPU / ${memory}MB RAM / ${disk}GB disk)..."

    # Create sandbox with resource flags and auto-stop disabled
    local output
    output=$(daytona create \
        --name "${name}" \
        --cpu "${cpu}" \
        --memory "${memory}" \
        --disk "${disk}" \
        --auto-stop 0 \
        --auto-archive 0 \
        2>&1)
    local exit_code=$?

    if [[ ${exit_code} -ne 0 ]]; then
        log_error "Failed to create sandbox: ${output}"
        return 1
    fi

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
    log_info "Sandbox created: ${DAYTONA_SANDBOX_ID}"
}

wait_for_cloud_init() {
    log_warn "Installing base tools in sandbox..."
    run_server "apt-get update -y && apt-get install -y curl unzip git zsh" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# Daytona uses `daytona exec` for running commands in sandboxes
run_server() {
    local cmd="${1}"
    daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "${cmd}"
}

upload_file() {
    local local_path="${1}"
    local remote_path="${2}"
    # Upload via base64 encoding through exec (no native CLI file upload)
    local content
    content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")
    daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Daytona has true SSH support — much better than exec-only providers
interactive_session() {
    local cmd="${1}"
    if [[ -z "${cmd}" ]]; then
        # Pure interactive shell via SSH
        daytona ssh "${DAYTONA_SANDBOX_ID}"
    else
        # Run a specific command interactively via exec
        daytona exec "${DAYTONA_SANDBOX_ID}" -- bash -c "${cmd}"
    fi
}

destroy_server() {
    local sandbox_id="${1:-${DAYTONA_SANDBOX_ID:-}}"
    if [[ -z "${sandbox_id}" ]]; then
        log_warn "No sandbox ID to destroy"
        return 0
    fi
    log_warn "Destroying sandbox ${sandbox_id}..."
    daytona delete "${sandbox_id}" 2>/dev/null || true
    log_info "Sandbox destroyed"
}

list_servers() {
    daytona list
}
