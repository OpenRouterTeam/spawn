#!/bin/bash
# Common bash functions for GitHub Codespaces spawn scripts
# Uses GitHub CLI (gh) for provisioning and SSH access

# Bash safety flags
set -eo pipefail

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# GitHub Codespaces specific functions
# ============================================================

# Ensure gh CLI is installed
ensure_gh_cli() {
    if command -v gh &>/dev/null; then
        log_info "GitHub CLI (gh) available"
        return 0
    fi

    log_step "Installing GitHub CLI (gh)..."

    # Detect OS and install accordingly
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            brew install gh || {
                log_error "Failed to install gh via Homebrew"
                return 1
            }
        else
            log_error "Homebrew not found. Install from https://cli.github.com/"
            return 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
        sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
        sudo apt update
        sudo apt install gh -y || {
            log_error "Failed to install gh via apt"
            return 1
        }
    else
        log_error "Unsupported OS. Install from https://cli.github.com/"
        return 1
    fi

    if ! command -v gh &>/dev/null; then
        log_error "gh not found in PATH after installation"
        return 1
    fi

    log_info "GitHub CLI (gh) installed"
}

# Ensure user is authenticated with gh CLI
ensure_gh_auth() {
    if ! gh auth status &>/dev/null; then
        log_warn "Not authenticated with GitHub CLI"
        log_info "Initiating GitHub CLI authentication..."
        gh auth login || {
            log_error "Failed to authenticate with GitHub CLI"
            log_error "Run: gh auth login"
            return 1
        }
    fi
    log_info "Authenticated with GitHub CLI"
    return 0
}

# Create a new codespace
# Args: $1 = repo (e.g., "OpenRouterTeam/spawn")
#       $2 = machine type (optional, default: basicLinux32gb)
#       $3 = idle timeout (optional, default: 30m)
create_codespace() {
    local repo="$1"
    local machine="${2:-basicLinux32gb}"
    local idle_timeout="${3:-30m}"

    log_info "Creating GitHub Codespace..."
    log_info "Repo: $repo"
    log_info "Machine: $machine"
    log_info "Idle timeout: $idle_timeout"

    local codespace_name
    codespace_name=$(gh codespace create \
        --repo "$repo" \
        --machine "$machine" \
        --idle-timeout "$idle_timeout" \
        2>&1)

    if [[ $? -ne 0 ]]; then
        log_error "Failed to create codespace"
        log_error "$codespace_name"
        return 1
    fi

    echo "$codespace_name"
}

# Wait for codespace to be ready
# Args: $1 = codespace name
wait_for_codespace() {
    local codespace="$1"
    local max_attempts=60
    local attempt=0

    log_info "Waiting for codespace to be ready..."

    while [[ $attempt -lt $max_attempts ]]; do
        local state
        state=$(gh codespace view --codespace "$codespace" --json state --jq '.state' 2>/dev/null || echo "Unknown")

        if [[ "$state" == "Available" ]]; then
            log_info "Codespace is ready"
            return 0
        fi

        attempt=$((attempt + 1))
        sleep 2
    done

    log_error "Codespace failed to become ready after $max_attempts attempts"
    return 1
}

# Run command in codespace
# Args: $1 = codespace name
#       $2+ = command to run
run_in_codespace() {
    local codespace="$1"
    shift
    gh codespace ssh --codespace "$codespace" -- "$@"
}

# Copy file to codespace
# Args: $1 = codespace name
#       $2 = source file
#       $3 = destination path
copy_to_codespace() {
    local codespace="$1"
    local source="$2"
    local dest="$3"
    gh codespace cp "$source" "$codespace:$dest"
}

# Open interactive SSH session in codespace
# Args: $1 = codespace name
ssh_to_codespace() {
    local codespace="$1"
    log_info "Opening SSH session to codespace..."
    gh codespace ssh --codespace "$codespace"
}

# Delete a codespace
# Args: $1 = codespace name
delete_codespace() {
    local codespace="$1"
    log_info "Deleting codespace $codespace..."
    gh codespace delete --codespace "$codespace" --force || {
        log_warn "Failed to delete codespace (may already be deleted)"
    }
}

# Upload a file to codespace via gh codespace cp
# Args: $1 = local path
#       $2 = remote path
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! -f "$local_path" ]]; then
        log_error "Local file not found: $local_path"
        return 1
    fi

    if [[ -z "${CODESPACE_NAME:-}" ]]; then
        log_error "CODESPACE_NAME not set. Call create_codespace first."
        return 1
    fi

    gh codespace cp "$local_path" "${CODESPACE_NAME}:${remote_path}"
}

# Run a command on the codespace (wrapper matching other providers' interface)
# SECURITY: Uses printf %q to properly escape commands to prevent injection
run_server() {
    local cmd="$1"

    if [[ -z "${CODESPACE_NAME:-}" ]]; then
        log_error "CODESPACE_NAME not set. Call create_codespace first."
        return 1
    fi

    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    gh codespace ssh --codespace "$CODESPACE_NAME" -- bash -c "$escaped_cmd"
}

# Inject environment variables into shell config
# Writes to a temp file and uploads to avoid shell interpolation of values
inject_env_vars() {
    log_step "Injecting environment variables..."

    local env_temp
    env_temp=$(mktemp)
    chmod 600 "${env_temp}"
    track_temp_file "${env_temp}"

    generate_env_config "$@" > "${env_temp}"

    # Upload and append to .bashrc
    upload_file "${env_temp}" "/tmp/env_config"
    run_server "cat /tmp/env_config >> ~/.bashrc && rm /tmp/env_config"

    log_info "Environment variables configured"
}

# Get codespace info
# Args: $1 = codespace name
get_codespace_info() {
    local codespace="$1"
    gh codespace view --codespace "$codespace" --json name,state,machine,repository,idleTimeoutNotice
}
