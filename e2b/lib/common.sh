#!/bin/bash
# Common bash functions for E2B sandbox spawn scripts
# Uses E2B CLI (e2b) — https://e2b.dev
# Sandboxes are lightweight VMs that start in ~150ms
# No SSH — uses `e2b sandbox exec` for commands

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
# E2B specific functions
# ============================================================

ensure_e2b_cli() {
    if ! command -v e2b &>/dev/null; then
        log_warn "Installing E2B CLI..."
        npm install -g @e2b/cli 2>/dev/null || {
            log_error "Failed to install E2B CLI. Install manually: npm install -g @e2b/cli"
            return 1
        }
    fi
    log_info "E2B CLI available"
}

ensure_e2b_token() {
    if [[ -n "$E2B_API_KEY" ]]; then
        log_info "Using E2B API key from environment"; return 0
    fi
    local config_dir="$HOME/.config/spawn" config_file="$config_dir/e2b.json"
    if [[ -f "$config_file" ]]; then
        local saved_key=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_key',''))" 2>/dev/null)
        if [[ -n "$saved_key" ]]; then
            export E2B_API_KEY="$saved_key"
            log_info "Using E2B API key from $config_file"; return 0
        fi
    fi
    echo ""; log_warn "E2B API Key Required"
    echo -e "${YELLOW}Get your API key from: https://e2b.dev/dashboard${NC}"; echo ""
    local api_key
    api_key=$(validated_read "Enter your E2B API key: " validate_api_token) || return 1
    export E2B_API_KEY="$api_key"
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "api_key": "$api_key"
}
EOF
    chmod 600 "$config_file"
    log_info "API key saved to $config_file"
}

get_server_name() {
    get_resource_name "E2B_SANDBOX_NAME" "Enter sandbox name: "
}

create_server() {
    local name="$1"
    local template="${E2B_TEMPLATE:-base}"

    log_warn "Creating E2B sandbox '$name' (template: $template)..."

    # Create sandbox and capture ID
    local output=$(e2b sandbox create --template "$template" --name "$name" 2>&1)
    E2B_SANDBOX_ID=$(echo "$output" | grep -oE '[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}' | head -1)

    if [[ -z "$E2B_SANDBOX_ID" ]]; then
        # Try alternate parsing
        E2B_SANDBOX_ID=$(echo "$output" | grep -oE 'sandbox_[a-zA-Z0-9]+' | head -1)
    fi

    if [[ -z "$E2B_SANDBOX_ID" ]]; then
        log_error "Failed to create sandbox: $output"
        return 1
    fi

    export E2B_SANDBOX_ID
    log_info "Sandbox created: ID=$E2B_SANDBOX_ID"
}

wait_for_cloud_init() {
    log_warn "Installing base tools in sandbox..."
    run_server "apt-get update -y && apt-get install -y curl unzip git zsh" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1 || true
    run_server "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' >/dev/null 2>&1 || true
    run_server 'echo "export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' >/dev/null 2>&1 || true
    log_info "Base tools installed"
}

# E2B uses sandbox exec instead of SSH
run_server() {
    local cmd="$1"
    e2b sandbox exec "$E2B_SANDBOX_ID" -- bash -c "$cmd"
}

upload_file() {
    local local_path="$1"
    local remote_path="$2"
    # Upload via base64 encoding through exec
    local content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")
    e2b sandbox exec "$E2B_SANDBOX_ID" -- bash -c "echo '$content' | base64 -d > '$remote_path'"
}

interactive_session() {
    local cmd="$1"
    e2b sandbox exec "$E2B_SANDBOX_ID" -- bash -c "$cmd"
}

destroy_server() {
    local sandbox_id="${1:-$E2B_SANDBOX_ID}"
    log_warn "Destroying sandbox $sandbox_id..."
    e2b sandbox kill "$sandbox_id" 2>/dev/null || true
    log_info "Sandbox destroyed"
}

list_servers() {
    e2b sandbox list
}
