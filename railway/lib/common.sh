#!/bin/bash
# Common bash functions for Railway spawn scripts
# Uses Railway CLI for provisioning and SSH access

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
# Railway specific functions
# ============================================================

# Ensure Railway CLI is installed
ensure_railway_cli() {
    if command -v railway &>/dev/null; then
        log_info "Railway CLI available"
        return 0
    fi

    log_warn "Installing Railway CLI..."
    if command -v npm &>/dev/null; then
        npm install -g @railway/cli 2>/dev/null || {
            log_error "Failed to install Railway CLI via npm"
            log_error "Install manually: npm install -g @railway/cli"
            return 1
        }
    else
        # Use the official installer script
        bash <(curl -fsSL cli.new) 2>/dev/null || {
            log_error "Failed to install Railway CLI"
            log_error "Install manually: bash <(curl -fsSL cli.new)"
            return 1
        }
    fi

    if ! command -v railway &>/dev/null; then
        log_error "Railway CLI not found in PATH after installation"
        return 1
    fi

    log_info "Railway CLI installed"
}

# Ensure RAILWAY_TOKEN is available (env var -> config file -> prompt+save)
ensure_railway_token() {
    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
        log_info "Using Railway token from environment"
        return 0
    fi

    # 2. Check config file
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/railway.json"
    if [[ -f "$config_file" ]]; then
        local saved_token=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1])).get('token',''))" "$config_file" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export RAILWAY_TOKEN="$saved_token"
            log_info "Using Railway token from $config_file"
            return 0
        fi
    fi

    # 3. Try to login interactively via Railway CLI
    if command -v railway &>/dev/null; then
        log_warn "Railway CLI requires authentication"
        log_warn "Opening browser for Railway login..."
        railway login || {
            log_error "Railway login failed"
            return 1
        }
        log_info "Railway login successful"

        # Try to extract token from CLI (Railway stores tokens internally)
        # We'll just rely on railway commands working after login
        return 0
    fi

    # 4. Prompt for token
    echo ""
    log_warn "Railway Token Required"
    echo -e "${YELLOW}Get your token at: https://railway.app/account/tokens${NC}"
    echo ""

    local token=$(safe_read "Enter your Railway token: ") || return 1
    if [[ -z "$token" ]]; then
        log_error "Token cannot be empty"
        log_warn "For non-interactive usage, set: RAILWAY_TOKEN=your-token"
        return 1
    fi

    # Save to config file
    export RAILWAY_TOKEN="$token"
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "token": "$token"
}
EOF
    chmod 600 "$config_file"
    log_info "Token saved to $config_file"
}

# Validate server name (Railway project name)
validate_server_name() {
    local name="$1"
    if [[ ! "$name" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
        log_error "Invalid project name: $name"
        log_error "Must start and end with alphanumeric, contain only lowercase letters, numbers, and hyphens"
        return 1
    fi
    if [[ "${#name}" -gt 50 ]]; then
        log_error "Project name too long (max 50 characters): $name"
        return 1
    fi
    echo "$name"
}

# Get server name from env var or prompt
get_server_name() {
    if [[ -n "${RAILWAY_PROJECT_NAME:-}" ]]; then
        log_info "Using project name from environment: $RAILWAY_PROJECT_NAME"
        if ! validate_server_name "$RAILWAY_PROJECT_NAME"; then
            return 1
        fi
        echo "$RAILWAY_PROJECT_NAME"
        return 0
    fi

    local server_name=$(safe_read "Enter project name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Project name is required"
        log_warn "Set RAILWAY_PROJECT_NAME environment variable for non-interactive usage:"
        log_warn "  RAILWAY_PROJECT_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Create a Railway project and service
create_server() {
    local name="$1"

    log_warn "Creating Railway project '$name'..."

    # Create a temporary directory for the project
    local project_dir="$HOME/.spawn-railway/$name"
    mkdir -p "$project_dir"
    cd "$project_dir"

    # Initialize new project
    railway init --name "$name" || {
        log_error "Failed to create Railway project"
        return 1
    }

    log_info "Project '$name' created"

    # Deploy a simple Ubuntu container with sleep to keep it running
    log_warn "Creating service with Ubuntu 24.04..."

    # Create a simple Dockerfile
    cat > Dockerfile << 'EOF'
FROM ubuntu:24.04

# Install base tools
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    unzip \
    python3 \
    python3-pip \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Keep container running
CMD ["sleep", "infinity"]
EOF

    # Deploy the service
    log_warn "Deploying service (this may take 1-2 minutes)..."
    railway up --detach || {
        log_error "Failed to deploy service"
        return 1
    }

    # Export variables for later use
    export RAILWAY_PROJECT_DIR="$project_dir"
    export RAILWAY_PROJECT_NAME="$name"

    log_info "Service deployed and running"

    # Wait a moment for the service to be fully ready
    sleep 5
}

# Wait for cloud-init (not needed for Railway, but kept for compatibility)
wait_for_cloud_init() {
    log_warn "Installing additional tools..."
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server 'printf "export PATH=\"\$HOME/.bun/bin:\$PATH\"\n" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'printf "export PATH=\"\$HOME/.bun/bin:\$PATH\"\n" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Additional tools installed"
}

# Run a command on the Railway service via railway run
# SECURITY: Uses printf %q to properly escape commands to prevent injection
run_server() {
    local cmd="$1"
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    cd "$RAILWAY_PROJECT_DIR"
    railway run bash -c "$escaped_cmd" 2>/dev/null
}

# Upload a file to the service via base64 encoding through exec
upload_file() {
    local local_path="$1"
    local remote_path="$2"
    local content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")
    # SECURITY: Properly escape paths and content
    local escaped_path
    escaped_path=$(printf '%q' "$remote_path")
    local escaped_content
    escaped_content=$(printf '%q' "$content")
    run_server "printf '%s' $escaped_content | base64 -d > $escaped_path"
}

# Start an interactive SSH session on the Railway service
interactive_session() {
    local cmd="$1"
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$cmd")
    cd "$RAILWAY_PROJECT_DIR"
    railway run bash -c "$escaped_cmd"
}

# Destroy a Railway project
destroy_server() {
    local project_name="${1:-$RAILWAY_PROJECT_NAME}"

    log_warn "Destroying Railway project '$project_name'..."

    local project_dir="$HOME/.spawn-railway/$project_name"
    if [[ -d "$project_dir" ]]; then
        cd "$project_dir"
        railway down || true
        cd ~
        rm -rf "$project_dir"
    fi

    log_info "Project '$project_name' destroyed"
}

# Inject environment variables into both .bashrc and .zshrc
# Usage: inject_env_vars_railway KEY1=VAL1 KEY2=VAL2 ...
inject_env_vars_railway() {
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

# List all Railway projects
list_servers() {
    log_warn "Listing Railway projects..."
    railway list || {
        log_error "Failed to list Railway projects"
        return 1
    }
}
