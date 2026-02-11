#!/bin/bash
# Common bash functions for Northflank spawn scripts
# Uses Northflank CLI (northflank) — https://northflank.com
# Containers with exec/shell access via CLI
# Free tier: 2 services, pay-per-second pricing after

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
# Northflank specific functions
# ============================================================

ensure_northflank_cli() {
    if ! command -v northflank &>/dev/null; then
        log_step "Installing Northflank CLI..."
        npm install -g @northflank/cli 2>/dev/null || {
            log_error "Failed to install Northflank CLI. Install manually: npm install -g @northflank/cli"
            return 1
        }
    fi
    log_info "Northflank CLI available"
}

test_northflank_token() {
    # Login with the token and validate by listing projects
    if ! northflank login -t "${NORTHFLANK_TOKEN}" &>/dev/null; then
        log_error "Failed to authenticate with Northflank CLI"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify API token at: https://northflank.com/account/settings/api/tokens"
        log_error "  2. Ensure the token has appropriate permissions"
        log_error "  3. Check token hasn't expired (90 day limit)"
        return 1
    fi
    return 0
}

ensure_northflank_token() {
    ensure_api_token_with_provider \
        "Northflank" \
        "NORTHFLANK_TOKEN" \
        "$HOME/.config/spawn/northflank.json" \
        "https://northflank.com/account/settings/api/tokens" \
        "test_northflank_token"
}

get_server_name() {
    get_resource_name "NORTHFLANK_SERVICE_NAME" "Enter service name: "
}

get_project_name() {
    get_resource_name "NORTHFLANK_PROJECT_NAME" "Enter project name: "
}

# Wait for a Northflank service to become running
# Usage: _northflank_wait_for_service NAME PROJECT [MAX_ATTEMPTS]
_northflank_wait_for_service() {
    local name="$1"
    local project_name="$2"
    local max_attempts="${3:-60}"
    local attempt=1

    log_step "Waiting for service to start..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        local status
        status=$(northflank get service --name "${name}" --project "${project_name}" 2>/dev/null | grep -i "status" || true)
        if echo "${status}" | grep -qi "running\|active"; then
            log_info "Service is running"
            return 0
        fi

        log_step "Waiting for service to start (${attempt}/${max_attempts})..."
        sleep 3
        attempt=$((attempt + 1))
    done

    log_error "Service did not start in time"
    return 1
}

create_server() {
    local name="${1}"
    local image="${NORTHFLANK_IMAGE:-ubuntu:24.04}"
    local project_name="${NORTHFLANK_PROJECT_NAME:-spawn-project}"

    log_step "Creating Northflank project '${project_name}'..."

    # Create project (idempotent - won't fail if exists)
    northflank create project \
        --name "${project_name}" \
        --description "Spawn AI agent deployment" 2>/dev/null || true

    log_info "Project '${project_name}' ready"
    export NORTHFLANK_PROJECT_NAME="${project_name}"

    log_step "Creating service '${name}' with image: ${image}"

    # Create deployment service with Docker image
    local service_output
    service_output=$(northflank create service deployment \
        --name "${name}" \
        --project "${project_name}" \
        --image "${image}" \
        --cpu 0.5 \
        --memory 1024 \
        --replicas 1 2>&1)

    if [[ $? -ne 0 ]]; then
        log_error "Failed to create service: ${service_output}"
        return 1
    fi

    export NORTHFLANK_SERVICE_NAME="${name}"
    log_info "Service '${name}' created"

    _northflank_wait_for_service "${name}" "${project_name}"
}

wait_for_cloud_init() {
    log_step "Installing base tools in container..."

    # Update package lists and install essentials
    run_server "apt-get update -y && apt-get install -y curl git unzip python3 pip" >/dev/null 2>&1 || true

    # Install bun for agent CLI tools
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' >/dev/null 2>&1 || true

    log_info "Base tools installed"
}

# Run a command on the Northflank service via northflank exec
run_server() {
    local cmd="${1}"
    local project="${NORTHFLANK_PROJECT_NAME}"
    local service="${NORTHFLANK_SERVICE_NAME}"

    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "${cmd}")

    # Use northflank exec with non-interactive mode
    northflank exec \
        --project "${project}" \
        --service "${service}" \
        --command "bash -c ${escaped_cmd}" 2>/dev/null
}

# Upload a file to the service via base64 encoding through exec
upload_file() {
    local local_path="${1}"
    local remote_path="${2}"

    # SECURITY: Validate remote_path to prevent command injection via single-quote breakout
    if [[ "$remote_path" == *"'"* || "$remote_path" == *'$'* || "$remote_path" == *'`'* || "$remote_path" == *$'\n'* ]]; then
        log_error "Invalid remote path (contains unsafe characters): $remote_path"
        return 1
    fi

    # base64 output is safe (alphanumeric + /+=) so no injection risk
    local content
    content=$(base64 -w0 "${local_path}" 2>/dev/null || base64 "${local_path}")

    run_server "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Start an interactive shell session on the Northflank service
interactive_session() {
    local cmd="${1}"
    local project="${NORTHFLANK_PROJECT_NAME}"
    local service="${NORTHFLANK_SERVICE_NAME}"

    # SECURITY: Properly escape command to prevent injection
    local escaped_cmd
    escaped_cmd=$(printf '%q' "${cmd}")

    # Use northflank exec for interactive shell
    northflank exec \
        --project "${project}" \
        --service "${service}" \
        --command "bash -c ${escaped_cmd}"
}

# Destroy a Northflank service
destroy_server() {
    local service_name="${1:-${NORTHFLANK_SERVICE_NAME}}"
    local project_name="${NORTHFLANK_PROJECT_NAME}"

    log_step "Destroying service '${service_name}'..."

    northflank delete service \
        --name "${service_name}" \
        --project "${project_name}" \
        --yes 2>/dev/null || true

    log_info "Service destroyed"
}

# Inject environment variables into .bashrc and .zshrc
inject_env_vars_northflank() {
    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to both .bashrc and .zshrc
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> ~/.bashrc && cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"

    # Note: temp file will be cleaned up by trap handler
}

# List Northflank services
list_servers() {
    log_info "Northflank services:"
    northflank list services 2>/dev/null || {
        log_error "Failed to list Northflank services"
        return 1
    }
}
