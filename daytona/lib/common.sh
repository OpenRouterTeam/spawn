#!/bin/bash
# Common bash functions for Daytona sandbox spawn scripts
# Uses Daytona REST API + direct SSH — no CLI required
# Sandboxes are cloud dev environments with token-based SSH access
# API docs: https://www.daytona.io/docs/en/

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

# ============================================================
# Daytona specific functions
# ============================================================

readonly DAYTONA_API_BASE="https://app.daytona.io/api"
SPAWN_DASHBOARD_URL="https://app.daytona.io/"

# Centralized curl wrapper for Daytona API
daytona_api() {
    local method="${1}"
    local endpoint="${2}"
    local body="${3:-}"
    generic_cloud_api "${DAYTONA_API_BASE}" "${DAYTONA_API_KEY}" "${method}" "${endpoint}" "${body}"
}

# Test that the API key works
test_daytona_token() {
    local response
    response=$(daytona_api GET "/sandbox?page=1&limit=1")
    if printf '%s' "${response}" | grep -qi '"statusCode"\s*:\s*4\|"unauthorized"\|"forbidden"'; then
        log_error "Invalid API key"
        log_error "How to fix:"
        log_warn "  1. Get or verify your API key at: https://app.daytona.io/dashboard/keys"
        log_warn "  2. Ensure the key has sandbox permissions"
        log_warn "  3. Check the key hasn't expired or been revoked"
        return 1
    fi
    return 0
}

# Ensure DAYTONA_API_KEY is available (env var -> config file -> prompt+save)
ensure_daytona_token() {
    ensure_api_token_with_provider \
        "Daytona" \
        "DAYTONA_API_KEY" \
        "${HOME}/.config/spawn/daytona.json" \
        "https://app.daytona.io/dashboard/keys" \
        "test_daytona_token"
}

# Get sandbox name from env var or prompt
get_server_name() {
    get_validated_server_name "DAYTONA_SANDBOX_NAME" "Enter sandbox name: "
}

# Create a Daytona sandbox via REST API and set up SSH access
create_server() {
    local name="${1}"

    log_step "Creating Daytona sandbox '${name}'..."

    # Build create body — jq for safe JSON encoding
    local body
    body=$(jq -n --arg name "${name}" '{
        name: $name,
        autoStopInterval: 0,
        autoArchiveInterval: 0
    }')

    local response
    response=$(daytona_api POST "/sandbox" "${body}")

    # Extract sandbox ID
    DAYTONA_SANDBOX_ID=$(_extract_json_field "${response}" "d.get('id','')")
    if [[ -z "${DAYTONA_SANDBOX_ID}" || "${DAYTONA_SANDBOX_ID}" == "null" ]]; then
        log_error "Failed to create sandbox: $(extract_api_error_message "${response}" "Unknown error")"
        return 1
    fi

    log_info "Sandbox created: ${DAYTONA_SANDBOX_ID}"

    # Wait for sandbox to reach started state
    log_step "Waiting for sandbox to start..."
    local max_wait=120 waited=0
    while [[ ${waited} -lt ${max_wait} ]]; do
        local status_resp
        status_resp=$(daytona_api GET "/sandbox/${DAYTONA_SANDBOX_ID}")
        local state
        state=$(_extract_json_field "${status_resp}" "d.get('state','')")

        if [[ "${state}" == "started" || "${state}" == "running" ]]; then
            break
        fi
        if [[ "${state}" == "error" || "${state}" == "failed" ]]; then
            local err_reason
            err_reason=$(_extract_json_field "${status_resp}" "d.get('errorReason','unknown')")
            log_error "Sandbox entered error state: ${err_reason}"
            return 1
        fi

        sleep 3
        waited=$((waited + 3))
    done

    if [[ ${waited} -ge ${max_wait} ]]; then
        log_error "Sandbox did not start within ${max_wait}s"
        log_warn "Check sandbox status at: ${SPAWN_DASHBOARD_URL}"
        return 1
    fi

    # Create SSH access token (8 hours)
    _setup_ssh_access

    export DAYTONA_SANDBOX_ID
    save_vm_connection "${DAYTONA_SSH_HOST}" "${SSH_USER}" "${DAYTONA_SANDBOX_ID}" "${name}" "daytona"
}

# Request an SSH access token and configure SSH connection variables
_setup_ssh_access() {
    log_step "Setting up SSH access..."

    local ssh_resp
    ssh_resp=$(daytona_api POST "/sandbox/${DAYTONA_SANDBOX_ID}/ssh-access?expiresInMinutes=480")

    DAYTONA_SSH_TOKEN=$(_extract_json_field "${ssh_resp}" "d.get('token','')")
    local ssh_cmd
    ssh_cmd=$(_extract_json_field "${ssh_resp}" "d.get('sshCommand','')")

    if [[ -z "${DAYTONA_SSH_TOKEN}" || "${DAYTONA_SSH_TOKEN}" == "null" ]]; then
        log_error "Failed to get SSH access: $(extract_api_error_message "${ssh_resp}" "Unknown error")"
        return 1
    fi

    # Parse host and port from sshCommand (e.g., "ssh -p 2222 TOKEN@HOST" or "ssh TOKEN@HOST")
    DAYTONA_SSH_HOST=$(printf '%s' "${ssh_cmd}" | grep -oE '[^@ ]+$')

    # Check for explicit port (-p PORT)
    DAYTONA_SSH_PORT=""
    if printf '%s' "${ssh_cmd}" | grep -q '\-p '; then
        DAYTONA_SSH_PORT=$(printf '%s' "${ssh_cmd}" | sed -n 's/.*-p \([0-9]*\).*/\1/p')
    fi

    # Default host if parsing fails
    if [[ -z "${DAYTONA_SSH_HOST:-}" ]]; then
        DAYTONA_SSH_HOST="ssh.app.daytona.io"
    fi

    # Configure SSH for Daytona's token-based auth.
    # The token IS the username — no key or password needed. The gateway
    # validates the token during the SSH "none" auth exchange.
    #   BatchMode=yes        — never prompt for passwords/passphrases (prevents hangs)
    #   PubkeyAuthentication — skip trying local SSH keys against the gateway
    #   ControlMaster/Path   — multiplex all SSH/SCP over one persistent connection
    #                          (avoids repeated auth negotiation + gateway rate limits)
    SSH_USER="${DAYTONA_SSH_TOKEN}"
    DAYTONA_SSH_CONTROL="/tmp/spawn-daytona-ssh-${DAYTONA_SANDBOX_ID}"
    SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o BatchMode=yes -o PubkeyAuthentication=no -o ControlMaster=auto -o ControlPath=${DAYTONA_SSH_CONTROL} -o ControlPersist=300"
    if [[ -n "${DAYTONA_SSH_PORT}" ]]; then
        SSH_OPTS="${SSH_OPTS} -p ${DAYTONA_SSH_PORT}"
    fi

    export DAYTONA_SSH_TOKEN DAYTONA_SSH_HOST DAYTONA_SSH_CONTROL SSH_USER SSH_OPTS
    log_info "SSH access ready"
}

wait_for_cloud_init() {
    # Verify SSH connectivity
    ssh_verify_connectivity "${DAYTONA_SSH_HOST}"

    log_step "Installing base tools in sandbox..."
    ssh_run_server "${DAYTONA_SSH_HOST}" "apt-get update -y && apt-get install -y curl unzip git zsh nodejs npm" >/dev/null 2>&1 || true
    ssh_run_server "${DAYTONA_SSH_HOST}" "npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx" >/dev/null 2>&1 || true
    ssh_run_server "${DAYTONA_SSH_HOST}" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    ssh_run_server "${DAYTONA_SSH_HOST}" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    ssh_run_server "${DAYTONA_SSH_HOST}" 'echo "export PATH=\"${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    ssh_run_server "${DAYTONA_SSH_HOST}" 'echo "export PATH=\"${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# SSH operations — delegates to shared helpers (same as Hetzner, DigitalOcean, etc.)
run_server() { ssh_run_server "${DAYTONA_SSH_HOST}" "$1"; }
upload_file() { ssh_upload_file "${DAYTONA_SSH_HOST}" "$1" "$2"; }

# Interactive session needs BatchMode=no so the PTY works.
# Close the multiplexed master first — ssh -t and ControlMaster don't mix well.
interactive_session() {
    # Tear down the connection-multiplexing master before handing off to the
    # interactive session.  The -t flag (allocated by ssh_interactive_session)
    # and ControlMaster can conflict, causing "mux_client: master did not
    # respond" errors.
    local exit_opts="-o ControlPath=${DAYTONA_SSH_CONTROL}"
    if [[ -n "${DAYTONA_SSH_PORT:-}" ]]; then
        exit_opts="${exit_opts} -p ${DAYTONA_SSH_PORT}"
    fi
    # shellcheck disable=SC2086
    ssh -O exit ${exit_opts} "${SSH_USER}@${DAYTONA_SSH_HOST}" 2>/dev/null || true

    local saved_opts="${SSH_OPTS}"
    # Strip multiplexing and BatchMode for the interactive session
    SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -o PubkeyAuthentication=no"
    if [[ -n "${DAYTONA_SSH_PORT:-}" ]]; then
        SSH_OPTS="${SSH_OPTS} -p ${DAYTONA_SSH_PORT}"
    fi
    ssh_interactive_session "${DAYTONA_SSH_HOST}" "$1"
    local rc=$?
    SSH_OPTS="${saved_opts}"
    return "${rc}"
}

# Destroy a Daytona sandbox
destroy_server() {
    local sandbox_id="${1:-${DAYTONA_SANDBOX_ID:-}}"
    if [[ -z "${sandbox_id}" ]]; then
        log_warn "No sandbox ID to destroy"
        return 0
    fi
    # Close SSH multiplexing master if still open
    if [[ -n "${DAYTONA_SSH_CONTROL:-}" ]]; then
        local exit_opts="-o ControlPath=${DAYTONA_SSH_CONTROL}"
        if [[ -n "${DAYTONA_SSH_PORT:-}" ]]; then
            exit_opts="${exit_opts} -p ${DAYTONA_SSH_PORT}"
        fi
        # shellcheck disable=SC2086
        ssh -O exit ${exit_opts} "${SSH_USER}@${DAYTONA_SSH_HOST}" 2>/dev/null || true
    fi
    log_step "Destroying sandbox ${sandbox_id}..."
    daytona_api DELETE "/sandbox/${sandbox_id}" >/dev/null 2>&1 || true
    log_info "Sandbox destroyed"
}

# List all Daytona sandboxes
list_servers() {
    local response
    response=$(daytona_api GET "/sandbox")

    printf '%s' "${response}" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    items = data if isinstance(data, list) else data.get('items', data.get('sandboxes', []))
    if not items:
        print('No sandboxes found')
        sys.exit(0)
    fmt = '%-25s %-40s %-12s'
    print(fmt % ('NAME', 'ID', 'STATE'))
    print('-' * 77)
    for s in items:
        print(fmt % (s.get('name','N/A')[:25], s.get('id','N/A')[:40], s.get('state','N/A')[:12]))
except Exception as e:
    print('Error listing sandboxes: %s' % e, file=sys.stderr)
" 2>/dev/null || printf 'Error parsing sandbox list\n'
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { prompt_spawn_name; ensure_daytona_token; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { wait_for_cloud_init; }
cloud_run() { run_server "$1"; }
cloud_upload() { upload_file "$1" "$2"; }
cloud_interactive() { interactive_session "$1"; }
cloud_label() { echo "Daytona sandbox"; }
