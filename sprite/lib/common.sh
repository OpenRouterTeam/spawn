#!/bin/bash
set -eo pipefail
# Common bash functions shared between spawn scripts

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Check if sprite CLI is installed, install if not
ensure_sprite_installed() {
    if ! command -v sprite &> /dev/null; then
        log_warn "Installing sprite CLI..."
        curl -fsSL https://sprites.dev/install.sh | bash
        export PATH="$HOME/.local/bin:$PATH"
    fi
}

# Check if already authenticated with sprite
ensure_sprite_authenticated() {
    if ! sprite org list &> /dev/null; then
        log_warn "Logging in to sprite..."
        sprite login || true
    fi
}

# Prompt for sprite name
get_sprite_name() {
    # Check if SPRITE_NAME is already set in environment
    if [[ -n "$SPRITE_NAME" ]]; then
        log_info "Using sprite name from environment: $SPRITE_NAME"
        if ! validate_server_name "$SPRITE_NAME"; then
            return 1
        fi
        echo "$SPRITE_NAME"
        return 0
    fi

    # Try to read interactively
    local sprite_name=$(safe_read "Enter sprite name: ")
    if [[ -z "$sprite_name" ]]; then
        log_error "Sprite name is required"
        log_warn "Set SPRITE_NAME environment variable for non-interactive usage:"
        log_warn "  SPRITE_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    if ! validate_server_name "$sprite_name"; then
        return 1
    fi

    echo "$sprite_name"
}

# Check if sprite exists, create if not
ensure_sprite_exists() {
    local sprite_name=$1
    local sleep_time=${2:-3}

    if sprite list 2>/dev/null | grep -qE "^${sprite_name}( |$)"; then
        log_info "Sprite '$sprite_name' already exists"
    else
        log_warn "Creating sprite '$sprite_name'..."
        sprite create -skip-console "$sprite_name" || true
        log_warn "Waiting for sprite to be ready..."
        sleep "$sleep_time"
    fi
}

# Verify sprite is accessible (retry up to max_attempts)
verify_sprite_connectivity() {
    local sprite_name=$1
    local max_attempts=${2:-6}
    local attempt=1

    log_warn "Verifying sprite connectivity..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        if sprite exec -s "$sprite_name" -- echo "ok" >/dev/null 2>&1; then
            log_info "Sprite '$sprite_name' is ready"
            return 0
        fi
        log_warn "Sprite not ready, retrying ($attempt/$max_attempts)..."
        sleep 5
        ((attempt++))
    done

    log_error "Sprite '$sprite_name' failed to respond after $max_attempts attempts"
    return 1
}

# Helper function to run commands on sprite
run_sprite() {
    local sprite_name=$1
    local command=$2
    sprite exec -s "$sprite_name" -- bash -c "$command"
}

# Configure shell environment (PATH, zsh setup)
setup_shell_environment() {
    local sprite_name=$1
    log_warn "Configuring shell environment..."

    # Create temp file with path config
    local path_temp=$(mktemp)
    cat > "$path_temp" << 'EOF'

# [spawn:path]
export PATH="$HOME/.bun/bin:/.sprite/languages/bun/bin:$PATH"
EOF

    # Upload and append to shell configs
    sprite exec -s "$sprite_name" -file "$path_temp:/tmp/path_config" -- bash -c "cat /tmp/path_config >> ~/.zprofile && cat /tmp/path_config >> ~/.zshrc && rm /tmp/path_config"
    rm "$path_temp"

    # Switch bash to zsh
    local bash_temp=$(mktemp)
    cat > "$bash_temp" << 'EOF'
# [spawn:bash]
exec /usr/bin/zsh -l
EOF

    sprite exec -s "$sprite_name" -file "$bash_temp:/tmp/bash_config" -- bash -c "cat /tmp/bash_config > ~/.bash_profile && cat /tmp/bash_config > ~/.bashrc && rm /tmp/bash_config"
    rm "$bash_temp"
}

# Inject environment variables into sprite's shell config
# Usage: inject_env_vars_sprite SPRITE_NAME KEY1=val1 KEY2=val2 ...
# Example: inject_env_vars_sprite "$SPRITE_NAME" \
#            "OPENROUTER_API_KEY=$OPENROUTER_API_KEY" \
#            "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
inject_env_vars_sprite() {
    local sprite_name="$1"
    shift

    local env_temp=$(mktemp)
    chmod 600 "$env_temp"

    generate_env_config "$@" > "$env_temp"

    # Upload and append to .zshrc using sprite exec with -file flag
    sprite exec -s "$sprite_name" -file "$env_temp:/tmp/env_config" -- bash -c "cat /tmp/env_config >> ~/.zshrc && rm /tmp/env_config"
    rm "$env_temp"
}

# Note: Provider-agnostic functions (nc_listen, open_browser, OAuth helpers, validate_model_id) are now in shared/common.sh
