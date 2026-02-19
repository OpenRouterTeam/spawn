#!/bin/bash
set -eo pipefail
# Common bash functions shared between spawn scripts

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../../shared/common.sh" ]]; then
    source "${SCRIPT_DIR}/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Configurable timeout/delay constants
SPRITE_CONNECTIVITY_POLL_DELAY=${SPRITE_CONNECTIVITY_POLL_DELAY:-5}  # Delay between sprite connectivity checks

# Retry wrapper for transient Sprite API errors (TLS timeouts, connection resets, etc.)
# Usage: _sprite_retry "description" command [args...]
_sprite_retry() {
    local desc="$1"
    shift
    local attempt=1
    local max_retries=3
    local rc=0
    local stderr_file
    stderr_file=$(mktemp)

    while true; do
        rc=0
        "$@" 2>"${stderr_file}" || rc=$?
        if [[ "${rc}" -eq 0 ]]; then
            rm -f "${stderr_file}"
            return 0
        fi

        if [[ "${attempt}" -ge "${max_retries}" ]]; then
            cat "${stderr_file}" >&2 2>/dev/null || true
            rm -f "${stderr_file}"
            return "${rc}"
        fi

        local stderr_content
        stderr_content=$(cat "${stderr_file}" 2>/dev/null || true)
        case "${stderr_content}" in
            *"TLS handshake timeout"*|*"connection closed"*|*"connection reset"*|*"connection refused"*)
                log_warn "${desc}: Transient error, retrying (${attempt}/${max_retries})..."
                sleep 3
                attempt=$((attempt + 1))
                ;;
            *)
                cat "${stderr_file}" >&2 2>/dev/null || true
                rm -f "${stderr_file}"
                return "${rc}"
                ;;
        esac
    done
}

# Log that sprite was found, with version if available
# $1=optional location context (e.g. "at /path/to/sprite")
_log_sprite_found() {
    local context="${1:+ $1}"
    local ver
    ver=$(sprite version 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?' || true)
    if [[ -n "${ver}" ]]; then
        log_info "sprite ${ver} already installed${context}, skipping installation"
    else
        log_info "sprite already installed${context}, skipping installation"
    fi
}

# Check if sprite CLI is installed, install if not
ensure_sprite_installed() {
    # Check if sprite is already in PATH
    if command -v sprite &> /dev/null; then
        _log_sprite_found
        return 0
    fi

    # Check common installation paths (especially for Termux)
    local common_paths=(
        "${HOME}/.local/bin/sprite"
        "/data/data/com.termux/files/usr/bin/sprite"
        "/usr/local/bin/sprite"
        "/usr/bin/sprite"
    )

    for sprite_path in "${common_paths[@]}"; do
        if [[ -x "${sprite_path}" ]]; then
            local sprite_dir
            sprite_dir=$(dirname "${sprite_path}")
            export PATH="${sprite_dir}:${PATH}"
            _log_sprite_found "at ${sprite_path}"
            return 0
        fi
    done

    # sprite not found, install it
    log_step "Installing sprite CLI..."
    if ! curl -fsSL https://sprites.dev/install.sh | bash; then
        log_error "Failed to install sprite CLI"
        log_error ""
        log_error "Possible causes:"
        log_error "  - Network connectivity issues"
        log_error "  - Installation script download failed"
        log_error "  - Insufficient permissions for installation"
        log_error ""
        log_error "Manual installation:"
        log_error "  Visit https://sprites.dev for installation instructions"
        log_error "  Or try: curl -fsSL https://sprites.dev/install.sh | bash"
        return 1
    fi
    export PATH="${HOME}/.local/bin:${PATH}"

    # Verify installation succeeded
    if ! command -v sprite &> /dev/null; then
        log_error "Sprite CLI installation completed but command not found in PATH"
        log_error "Try adding to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
        return 1
    fi
}

# Detect the currently selected sprite org
# Sets SPRITE_ORG for use with -o flag in subsequent commands
_detect_sprite_org() {
    if [[ -n "${SPRITE_ORG:-}" ]]; then
        return 0
    fi
    # sed works on both macOS and Linux (no grep -P dependency)
    SPRITE_ORG=$(sprite org list 2>/dev/null | sed -n 's/.*Currently selected org: \([^ ]*\).*/\1/p' || true)
}

# Get org flags for sprite commands
_sprite_org_flags() {
    if [[ -n "${SPRITE_ORG:-}" ]]; then
        printf '%s' "-o ${SPRITE_ORG}"
    fi
}

# Check if already authenticated with sprite
ensure_sprite_authenticated() {
    if sprite org list &> /dev/null; then
        log_info "Already authenticated with Sprite"
        _detect_sprite_org
        return 0
    fi

    log_step "Logging in to Sprite..."
    if ! sprite login; then
        log_error "Sprite login failed"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Run 'sprite login' manually and follow the prompts"
        log_error "  2. Check your internet connection"
        log_error "  3. Visit https://sprites.dev to create an account if needed"
        return 1
    fi

    # Verify login actually succeeded
    if ! sprite org list &> /dev/null; then
        log_error "Sprite login completed but authentication check still fails"
        log_error "Try running 'sprite login' manually"
        return 1
    fi

    _detect_sprite_org
    log_info "Sprite authentication successful"
}

# Prompt for sprite name
get_sprite_name() {
    local sprite_name
    sprite_name=$(get_resource_name "SPRITE_NAME" "Enter sprite name: ") || return 1

    if ! validate_server_name "${sprite_name}"; then
        return 1
    fi

    echo "${sprite_name}"
}

# Check if sprite exists, create if not
ensure_sprite_exists() {
    local sprite_name=${1}
    local max_wait=${2:-30}

    # shellcheck disable=SC2046
    if sprite list $(_sprite_org_flags) 2>/dev/null | grep -qE "^${sprite_name}( |$)"; then
        log_info "Sprite '${sprite_name}' already exists"
        return 0
    fi

    log_step "Creating sprite '${sprite_name}'..."
    # shellcheck disable=SC2046
    if ! _sprite_retry "sprite create" sprite create $(_sprite_org_flags) -skip-console "${sprite_name}"; then
        log_error "Failed to create sprite '${sprite_name}'"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Check your Sprite authentication: sprite org list"
        log_error "  2. Re-login if needed: sprite login"
        log_error "  3. Check if you have reached your sprite limit: sprite list"
        return 1
    fi

    log_step "Waiting for sprite to be provisioned..."
    local elapsed=0
    while [[ "${elapsed}" -lt "${max_wait}" ]]; do
        # shellcheck disable=SC2046
        if sprite list $(_sprite_org_flags) 2>/dev/null | grep -qE "^${sprite_name}( |$)"; then
            log_info "Sprite '${sprite_name}' provisioned"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done

    log_error "Sprite '${sprite_name}' not found after ${max_wait}s"
    return 1
}

# Verify sprite is accessible (retry up to max_attempts)
verify_sprite_connectivity() {
    local sprite_name=${1}
    local max_attempts=${2:-6}
    local attempt=1

    log_step "Verifying sprite connectivity..."
    while [[ "${attempt}" -le "${max_attempts}" ]]; do
        # shellcheck disable=SC2046
        if sprite $(_sprite_org_flags) exec -s "${sprite_name}" -- echo "ok" >/dev/null 2>&1; then
            log_info "Sprite '${sprite_name}' is ready"
            return 0
        fi
        log_step "Sprite not ready, retrying (${attempt}/${max_attempts})..."
        sleep "${SPRITE_CONNECTIVITY_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Sprite '${sprite_name}' failed to respond after ${max_attempts} attempts"
    log_error ""
    log_error "How to fix:"
    log_error "  1. Check sprite status: sprite list"
    log_error "  2. View sprite logs: sprite logs ${sprite_name}"
    log_error "  3. Try recreating the sprite: sprite delete ${sprite_name} && sprite create ${sprite_name}"
    log_error "  4. Verify network connectivity to sprites.dev"
    log_error ""
    log_error "If issues persist, contact Sprite support: https://sprites.dev/support"
    return 1
}

# Helper function to run commands on sprite
# The command string is passed directly to bash -c for shell parsing.
# All callers pass trusted, hardcoded command strings (not user input).
run_sprite() {
    local sprite_name=${1}
    local command=${2}
    # shellcheck disable=SC2046
    _sprite_retry "sprite exec" sprite $(_sprite_org_flags) exec -s "${sprite_name}" -- bash -c "${command}"
}

# Configure shell environment (PATH, zsh setup)
setup_shell_environment() {
    local sprite_name=${1}
    log_step "Configuring shell environment..."

    # Clean up stale 'exec zsh' from prior runs that may block .bashrc sourcing
    # shellcheck disable=SC2046
    sprite $(_sprite_org_flags) exec -s "${sprite_name}" -- bash -c "sed -i '/exec \/usr\/bin\/zsh/d' ~/.bashrc ~/.bash_profile 2>/dev/null; true"

    # Create temp file with path config
    local path_temp
    path_temp=$(mktemp)
    trap 'rm -f "${path_temp}"' EXIT
    cat > "${path_temp}" << 'EOF'

# [spawn:path]
export PATH="${HOME}/.bun/bin:/.sprite/languages/bun/bin:${PATH}"
EOF

    # Upload and append to .bashrc and .zshrc only
    # shellcheck disable=SC2046
    _sprite_retry "sprite upload path_config" sprite $(_sprite_org_flags) exec -s "${sprite_name}" -file "${path_temp}:/tmp/path_config" -- bash -c "cat /tmp/path_config >> ~/.bashrc && cat /tmp/path_config >> ~/.zshrc && rm /tmp/path_config"

    # Switch bash to zsh only if zsh is available on the sprite
    # shellcheck disable=SC2046
    if sprite $(_sprite_org_flags) exec -s "${sprite_name}" -- bash -c "command -v zsh" >/dev/null 2>&1; then
        local bash_temp
        bash_temp=$(mktemp)
        trap 'rm -f "${path_temp}" "${bash_temp}"' EXIT
        cat > "${bash_temp}" << 'EOF'
# [spawn:bash]
exec /usr/bin/zsh -l
EOF

        # shellcheck disable=SC2046
        _sprite_retry "sprite upload bash_config" sprite $(_sprite_org_flags) exec -s "${sprite_name}" -file "${bash_temp}:/tmp/bash_config" -- bash -c "cat /tmp/bash_config > ~/.bash_profile && cat /tmp/bash_config > ~/.bashrc && rm /tmp/bash_config"
    else
        log_warn "zsh not available on sprite, keeping bash as default shell"
    fi
}

# Upload file to sprite (for use with setup_claude_code_config callback)
# Usage: upload_file_sprite SPRITE_NAME LOCAL_PATH REMOTE_PATH
# Example: upload_file_sprite "$SPRITE_NAME" "/tmp/settings.json" "/root/.claude/settings.json"
# SECURITY: Strict path validation + proper quoting to prevent injection
upload_file_sprite() {
    local sprite_name="${1}"
    local local_path="${2}"
    local remote_path="${3}"

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    # SECURITY: Generate cryptographically random temp path to prevent symlink attacks
    # Fallback chain: openssl (strongest) → /dev/urandom → failure (no weak fallback)
    local temp_random
    if command -v openssl &>/dev/null; then
        temp_random=$(openssl rand -hex 8)
    elif [[ -r /dev/urandom ]]; then
        temp_random=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
    else
        log_error "FATAL: Neither openssl nor /dev/urandom available for secure temp file generation"
        return 1
    fi

    local temp_remote="/tmp/sprite_upload_$(basename "${remote_path}")_${temp_random}"

    # shellcheck disable=SC2046
    _sprite_retry "sprite upload" sprite $(_sprite_org_flags) exec -s "${sprite_name}" -file "${local_path}:${temp_remote}" -- bash -c "mkdir -p \$(dirname '${remote_path}') && mv '${temp_remote}' '${remote_path}'"
}

# Destroy a sprite (standardized wrapper for cross-cloud compatibility)
destroy_server() {
    local sprite_name="$1"

    log_step "Destroying sprite '${sprite_name}'..."
    # shellcheck disable=SC2046
    if ! sprite $(_sprite_org_flags) destroy "${sprite_name}" 2>&1; then
        log_error "Failed to destroy sprite '${sprite_name}'"
        log_error ""
        log_error "The sprite may still be running and incurring charges."
        log_error "Delete it manually: sprite destroy ${sprite_name}"
        log_error "Or check status: sprite list"
        return 1
    fi

    log_info "Sprite '${sprite_name}' destroyed"
}

# Note: Provider-agnostic functions (nc_listen, open_browser, OAuth helpers, validate_model_id) are now in shared/common.sh

# ============================================================
# Cloud adapter interface
# ============================================================

# Wrapper for spawn_agent compatibility (sprite uses get_sprite_name)
get_server_name() { get_sprite_name; }

cloud_authenticate() { ensure_sprite_installed; ensure_sprite_authenticated; }
cloud_provision() {
    SPRITE_NAME="$1"
    ensure_sprite_exists "${SPRITE_NAME}"
    verify_sprite_connectivity "${SPRITE_NAME}"
    setup_shell_environment "${SPRITE_NAME}"
}
cloud_wait_ready() { :; }
cloud_run() { run_sprite "${SPRITE_NAME}" "$1"; }
cloud_upload() { upload_file_sprite "${SPRITE_NAME}" "$1" "$2"; }
cloud_interactive() {
    local cmd="$1"
    # shellcheck disable=SC2046
    if [[ -n "${SPAWN_PROMPT:-}" ]]; then
        sprite $(_sprite_org_flags) exec -s "${SPRITE_NAME}" -- bash -c "${cmd}"
    else
        sprite $(_sprite_org_flags) exec -s "${SPRITE_NAME}" -tty -- bash -c "${cmd}"
    fi
}
cloud_label() { echo "Sprite"; }
