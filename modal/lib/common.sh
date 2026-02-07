#!/bin/bash
# Common bash functions for Modal sandbox spawn scripts
# Uses Modal CLI + Python SDK — https://modal.com
# Sandboxes are secure containers with sub-second cold starts
# No SSH — uses `modal sandbox exec` for commands

# ============================================================
# Provider-agnostic functions
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}$1${NC}" >&2; }
log_warn() { echo -e "${YELLOW}$1${NC}" >&2; }
log_error() { echo -e "${RED}$1${NC}" >&2; }

safe_read() {
    local prompt="$1" result=""
    if [[ -t 0 ]]; then read -p "$prompt" result
    elif echo -n "" > /dev/tty 2>/dev/null; then read -p "$prompt" result < /dev/tty
    else log_error "Cannot read input: no TTY available"; return 1; fi
    echo "$result"
}

nc_listen() {
    local port=$1; shift
    if nc --help 2>&1 | grep -q "BusyBox\|busybox"; then
        nc -l -p "$port" "$@"
    else nc -l "$port" "$@"; fi
}

open_browser() {
    local url=$1
    if command -v termux-open-url &>/dev/null; then termux-open-url "$url" </dev/null
    elif command -v open &>/dev/null; then open "$url" </dev/null
    elif command -v xdg-open &>/dev/null; then xdg-open "$url" </dev/null
    else log_warn "Please open: ${url}"; fi
}

get_openrouter_api_key_manual() {
    echo ""; log_warn "Manual API Key Entry"
    echo -e "${YELLOW}Get your API key from: https://openrouter.ai/settings/keys${NC}"; echo ""
    local api_key=""
    while [[ -z "$api_key" ]]; do
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1
        if [[ -z "$api_key" ]]; then log_error "API key cannot be empty"
        elif [[ ! "$api_key" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "Warning: API key format doesn't match expected pattern (sk-or-v1-...)"
            local confirm=$(safe_read "Use this key anyway? (y/N): ") || return 1
            if [[ "$confirm" =~ ^[Yy]$ ]]; then break; else api_key=""; fi
        fi
    done
    log_info "API key accepted!"; echo "$api_key"
}

try_oauth_flow() {
    local callback_port=${1:-5180}
    log_warn "Attempting OAuth authentication..."
    if ! command -v nc &>/dev/null; then log_warn "netcat (nc) not found"; return 1; fi
    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"
    local oauth_dir=$(mktemp -d) code_file="$oauth_dir/code"
    log_warn "Starting local OAuth server on port ${callback_port}..."

    # Write the HTTP response to a file (using printf for macOS bash 3.x compat)
    local response_tpl="$oauth_dir/response.http"
    printf 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}h1{color:#00d4aa}p{color:#ffffffcc}</style></head><body><div class="card"><h1>Authentication Successful!</h1><p>You can close this tab</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>' > "$response_tpl"
    
    # Background listener
    (
        while true; do
            request=$(nc_listen "$callback_port" < "$response_tpl" 2>/dev/null | head -1) || break
            
            case "$request" in
                *"/callback?code="*)
                    echo "$request" | sed -n 's/.*code=\([^ &]*\).*/\1/p' > "$code_file"
                    break
                    ;;
            esac
        done
    ) </dev/null &
    local server_pid=$!; sleep 1
    if ! kill -0 $server_pid 2>/dev/null; then log_warn "Failed to start OAuth server"; rm -rf "$oauth_dir"; return 1; fi
    log_warn "Opening browser to authenticate with OpenRouter..."; open_browser "$auth_url"
    local timeout=120 elapsed=0
    while [[ ! -f "$code_file" ]] && [[ $elapsed -lt $timeout ]]; do sleep 1; elapsed=$((elapsed + 1)); done
    kill $server_pid 2>/dev/null || true; wait $server_pid 2>/dev/null || true
    if [[ ! -f "$code_file" ]]; then log_warn "OAuth timeout"; rm -rf "$oauth_dir"; return 1; fi
    local oauth_code=$(cat "$code_file"); rm -rf "$oauth_dir"
    log_warn "Exchanging OAuth code for API key..."
    local key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" -d "{\"code\": \"$oauth_code\"}")
    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')
    if [[ -z "$api_key" ]]; then log_error "Failed to exchange OAuth code: ${key_response}"; return 1; fi
    log_info "Successfully obtained OpenRouter API key via OAuth!"; echo "$api_key"
}

get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}
    local api_key=$(try_oauth_flow "$callback_port")
    if [[ -n "$api_key" ]]; then echo "$api_key"; return 0; fi
    echo ""; log_warn "OAuth authentication failed or unavailable"
    log_warn "You can enter your API key manually instead"; echo ""
    local manual_choice=$(safe_read "Would you like to enter your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable for non-interactive usage"; return 1
    }
    if [[ ! "$manual_choice" =~ ^[Nn]$ ]]; then
        api_key=$(get_openrouter_api_key_manual); echo "$api_key"; return 0
    else log_error "Authentication cancelled by user"; return 1; fi
}

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
    if [[ -n "$MODAL_SANDBOX_NAME" ]]; then
        log_info "Using sandbox name from environment: $MODAL_SANDBOX_NAME"
        echo "$MODAL_SANDBOX_NAME"; return 0
    fi
    local name=$(safe_read "Enter sandbox name: ")
    if [[ -z "$name" ]]; then
        log_error "Sandbox name is required"
        log_warn "Set MODAL_SANDBOX_NAME environment variable for non-interactive usage"; return 1
    fi
    echo "$name"
}

create_server() {
    local name="$1"
    local image="${MODAL_IMAGE:-debian_slim}"

    log_warn "Creating Modal sandbox '$name'..."

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

    if [[ -z "$MODAL_SANDBOX_ID" ]]; then
        log_error "Failed to create Modal sandbox"
        return 1
    fi

    export MODAL_SANDBOX_ID
    export MODAL_APP_NAME="spawn-${name}"
    export MODAL_SANDBOX_NAME_ACTUAL="$name"
    log_info "Sandbox created: ID=$MODAL_SANDBOX_ID"
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
    local cmd="$1"
    python3 -c "
import modal
sb = modal.Sandbox.from_id('$MODAL_SANDBOX_ID')
p = sb.exec('bash', '-c', '''$cmd''')
print(p.stdout.read(), end='')
if p.stderr.read():
    import sys; print(p.stderr.read(), end='', file=sys.stderr)
p.wait()
"
}

upload_file() {
    local local_path="$1"
    local remote_path="$2"
    local content=$(base64 -w0 "$local_path" 2>/dev/null || base64 "$local_path")
    run_server "echo '$content' | base64 -d > '$remote_path'"
}

interactive_session() {
    local cmd="$1"
    python3 -c "
import modal, sys
sb = modal.Sandbox.from_id('$MODAL_SANDBOX_ID')
p = sb.exec('bash', '-c', '''$cmd''', pty=True)
for line in p.stdout:
    print(line, end='')
p.wait()
"
}

destroy_server() {
    local sandbox_id="${1:-$MODAL_SANDBOX_ID}"
    log_warn "Terminating sandbox..."
    python3 -c "
import modal
sb = modal.Sandbox.from_id('$sandbox_id')
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
