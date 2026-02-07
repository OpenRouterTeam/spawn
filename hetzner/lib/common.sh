#!/bin/bash
# Common bash functions for Hetzner Cloud spawn scripts

# ============================================================
# Provider-agnostic functions (shared with sprite/lib/common.sh)
# ============================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Print colored message (to stderr so they don't pollute command substitution output)
log_info() {
    echo -e "${GREEN}$1${NC}" >&2
}

log_warn() {
    echo -e "${YELLOW}$1${NC}" >&2
}

log_error() {
    echo -e "${RED}$1${NC}" >&2
}

# Safe read function that works in both interactive and non-interactive modes
safe_read() {
    local prompt="$1"
    local result=""

    if [[ -t 0 ]]; then
        # stdin is a terminal - read directly
        read -p "$prompt" result
    elif echo -n "" > /dev/tty 2>/dev/null; then
        # /dev/tty is functional - use it
        read -p "$prompt" result < /dev/tty
    else
        # No interactive input available
        log_error "Cannot read input: no TTY available"
        return 1
    fi

    echo "$result"
}

# Listen on a port with netcat (handles busybox/Termux nc requiring -p flag)
nc_listen() {
    local port=$1
    shift
    # Detect if nc requires -p flag (busybox nc on Termux)
    if nc --help 2>&1 | grep -q "BusyBox\|busybox"; then
        nc -l -p "$port" "$@"
    else
        nc -l "$port" "$@"
    fi
}

# Open browser to URL (supports macOS, Linux, Termux)
open_browser() {
    local url=$1
    if command -v termux-open-url &> /dev/null; then
        termux-open-url "$url" </dev/null
    elif command -v open &> /dev/null; then
        open "$url" </dev/null
    elif command -v xdg-open &> /dev/null; then
        xdg-open "$url" </dev/null
    else
        log_warn "Please open: ${url}"
    fi
}

# Manually prompt for API key
get_openrouter_api_key_manual() {
    echo ""
    log_warn "Manual API Key Entry"
    echo -e "${YELLOW}Get your API key from: https://openrouter.ai/settings/keys${NC}"
    echo ""

    local api_key=""
    while [[ -z "$api_key" ]]; do
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1

        # Basic validation - OpenRouter keys typically start with "sk-or-"
        if [[ -z "$api_key" ]]; then
            log_error "API key cannot be empty"
        elif [[ ! "$api_key" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "Warning: API key format doesn't match expected pattern (sk-or-v1-...)"
            local confirm=$(safe_read "Use this key anyway? (y/N): ") || return 1
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                break
            else
                api_key=""
            fi
        fi
    done

    log_info "API key accepted!"
    echo "$api_key"
}

# Try OAuth flow, fallback to manual entry if it fails
try_oauth_flow() {
    local callback_port=${1:-5180}

    log_warn "Attempting OAuth authentication..."

    # Check if nc is available
    if ! command -v nc &> /dev/null; then
        log_warn "netcat (nc) not found - OAuth server unavailable"
        return 1
    fi

    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"

    # Create a temporary directory for the OAuth flow
    local oauth_dir=$(mktemp -d)
    local code_file="$oauth_dir/code"

    log_warn "Starting local OAuth server on port ${callback_port}..."

    # Write the HTTP response to a file (using printf for macOS bash 3.x compat)
    local response_tpl="$oauth_dir/response.http"
    printf 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>@keyframes checkmark{0%{transform:scale(0) rotate(-45deg);opacity:0}60%{transform:scale(1.2) rotate(-45deg);opacity:1}100%{transform:scale(1) rotate(-45deg);opacity:1}}@keyframes fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}.check{width:80px;height:80px;border-radius:50%;background:#00d4aa22;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.check::after{content:"";display:block;width:28px;height:14px;border-left:4px solid #00d4aa;border-bottom:4px solid #00d4aa;animation:checkmark .5s ease forwards}h1{color:#00d4aa;margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}.sub{color:#ffffff66;font-size:.85rem;animation:fadein .5s ease .5s both}</style></head><body><div class="card"><div class="check"></div><h1>Authentication Successful!</h1><p>Redirecting back to terminal...</p><p class="sub">This tab will close automatically</p></div><script>setTimeout(function(){try{window.close()}catch(e){}setTimeout(function(){document.querySelector(".sub").textContent="You can safely close this tab"},500)},3000)</script></body></html>' > "$response_tpl"
    
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
    local server_pid=$!

    # Give the server a moment to start and check if it's running
    sleep 1

    # Check if the background process is still running
    if ! kill -0 $server_pid 2>/dev/null; then
        log_warn "Failed to start OAuth server (port may be in use)"
        rm -rf "$oauth_dir"
        return 1
    fi

    # Open browser
    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "$auth_url"

    # Wait for the code file to be created (timeout after 2 minutes)
    local timeout=120
    local elapsed=0
    while [[ ! -f "$code_file" ]] && [[ $elapsed -lt $timeout ]]; do
        sleep 1
        elapsed=$((elapsed + 1))
    done

    # Kill the background server process
    kill $server_pid 2>/dev/null || true
    wait $server_pid 2>/dev/null || true

    if [[ ! -f "$code_file" ]]; then
        log_warn "OAuth timeout - no response received"
        rm -rf "$oauth_dir"
        return 1
    fi

    local oauth_code=$(cat "$code_file")
    rm -rf "$oauth_dir"

    # Exchange the code for an API key
    log_warn "Exchanging OAuth code for API key..."
    local key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" \
        -d "{\"code\": \"$oauth_code\"}")

    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')

    if [[ -z "$api_key" ]]; then
        log_error "Failed to exchange OAuth code: ${key_response}"
        return 1
    fi

    log_info "Successfully obtained OpenRouter API key via OAuth!"
    echo "$api_key"
}

# Main function: Try OAuth, fallback to manual entry
get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}

    # Try OAuth flow first
    local api_key=$(try_oauth_flow "$callback_port")

    if [[ -n "$api_key" ]]; then
        echo "$api_key"
        return 0
    fi

    # OAuth failed, offer manual entry
    echo ""
    log_warn "OAuth authentication failed or unavailable"
    log_warn "You can enter your API key manually instead"
    echo ""
    local manual_choice=$(safe_read "Would you like to enter your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable for non-interactive usage"
        return 1
    }

    if [[ ! "$manual_choice" =~ ^[Nn]$ ]]; then
        api_key=$(get_openrouter_api_key_manual)
        echo "$api_key"
        return 0
    else
        log_error "Authentication cancelled by user"
        return 1
    fi
}

# ============================================================
# Hetzner Cloud specific functions
# ============================================================

HETZNER_API_BASE="https://api.hetzner.cloud/v1"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

# Centralized curl wrapper for Hetzner API
hetzner_api() {
    local method="$1"
    local endpoint="$2"
    local body="$3"

    local args=(
        -s
        -X "$method"
        -H "Authorization: Bearer ${HCLOUD_TOKEN}"
        -H "Content-Type: application/json"
    )

    if [[ -n "$body" ]]; then
        args+=(-d "$body")
    fi

    curl "${args[@]}" "${HETZNER_API_BASE}${endpoint}"
}

# Ensure HCLOUD_TOKEN is available (env var → config file → prompt+save)
ensure_hcloud_token() {
    # 1. Check environment variable
    if [[ -n "$HCLOUD_TOKEN" ]]; then
        log_info "Using Hetzner API token from environment"
        return 0
    fi

    # 2. Check config file
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/hetzner.json"
    if [[ -f "$config_file" ]]; then
        local saved_token=$(python3 -c "import json; print(json.load(open('$config_file')).get('token',''))" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export HCLOUD_TOKEN="$saved_token"
            log_info "Using Hetzner API token from $config_file"
            return 0
        fi
    fi

    # 3. Prompt and save
    echo ""
    log_warn "Hetzner Cloud API Token Required"
    echo -e "${YELLOW}Get your token from: https://console.hetzner.cloud/projects → API Tokens${NC}"
    echo ""

    local token=$(safe_read "Enter your Hetzner API token: ") || return 1
    if [[ -z "$token" ]]; then
        log_error "API token is required"
        return 1
    fi

    # Validate token by making a test API call
    export HCLOUD_TOKEN="$token"
    local test_response=$(hetzner_api GET "/servers?per_page=1")
    if echo "$test_response" | grep -q '"error"'; then
        log_error "Invalid API token"
        unset HCLOUD_TOKEN
        return 1
    fi

    # Save to config file
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "token": "$token"
}
EOF
    chmod 600 "$config_file"
    log_info "API token saved to $config_file"
}

# Ensure SSH key exists locally and is registered with Hetzner
ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate SSH key if it doesn't exist
    if [[ ! -f "$key_path" ]]; then
        log_warn "Generating SSH key..."
        mkdir -p "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$key_path" -N "" -q
        log_info "SSH key generated at $key_path"
    fi

    local pub_key=$(cat "$pub_path")
    local key_name="spawn-$(hostname)-$(date +%s)"

    # Check if this key is already registered
    local existing_keys=$(hetzner_api GET "/ssh_keys")
    local existing_fingerprint=$(ssh-keygen -lf "$pub_path" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://')

    if echo "$existing_keys" | grep -q "$existing_fingerprint"; then
        log_info "SSH key already registered with Hetzner"
        return 0
    fi

    # Register the key
    log_warn "Registering SSH key with Hetzner..."
    local json_pub_key=$(python3 -c "import json; print(json.dumps('$pub_key'))" 2>/dev/null || echo "\"$pub_key\"")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response=$(hetzner_api POST "/ssh_keys" "$register_body")

    if echo "$register_response" | grep -q '"error"'; then
        log_error "Failed to register SSH key: $register_response"
        return 1
    fi

    log_info "SSH key registered with Hetzner"
}

# Get server name from env var or prompt
get_server_name() {
    if [[ -n "$HETZNER_SERVER_NAME" ]]; then
        log_info "Using server name from environment: $HETZNER_SERVER_NAME"
        echo "$HETZNER_SERVER_NAME"
        return 0
    fi

    local server_name=$(safe_read "Enter server name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Server name is required"
        log_warn "Set HETZNER_SERVER_NAME environment variable for non-interactive usage:"
        log_warn "  HETZNER_SERVER_NAME=dev-mk1 curl ... | bash"
        return 1
    fi

    echo "$server_name"
}

# Generate cloud-init userdata YAML
get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#cloud-config
package_update: true
packages:
  - curl
  - unzip
  - git
  - zsh

runcmd:
  # Install Bun
  - su - root -c 'curl -fsSL https://bun.sh/install | bash'
  # Install Claude Code
  - su - root -c 'curl -fsSL https://claude.ai/install.sh | bash'
  # Configure PATH in .bashrc
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.bashrc
  # Configure PATH in .zshrc
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.zshrc
  # Signal completion
  - touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

# Create a Hetzner server with cloud-init
create_server() {
    local name="$1"
    local server_type="${HETZNER_SERVER_TYPE:-cx22}"
    local location="${HETZNER_LOCATION:-fsn1}"
    local image="ubuntu-24.04"

    log_warn "Creating Hetzner server '$name' (type: $server_type, location: $location)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('ssh_keys', [])]
print(json.dumps(ids))
" <<< "$ssh_keys_response")

    # JSON-escape the cloud-init userdata
    local userdata=$(get_cloud_init_userdata)
    local userdata_json=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$userdata")

    local body=$(python3 -c "
import json
body = {
    'name': '$name',
    'server_type': '$server_type',
    'location': '$location',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': json.loads($userdata_json),
    'start_after_create': True
}
print(json.dumps(body))
")

    local response=$(hetzner_api POST "/servers" "$body")

    # Check for errors
    if echo "$response" | grep -q '"error"'; then
        local error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('error',{}).get('message','Unknown error'))")
        log_error "Failed to create server: $error_msg"
        return 1
    fi

    # Extract server ID and IP
    HETZNER_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])")
    HETZNER_SERVER_IP=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['public_net']['ipv4']['ip'])")
    export HETZNER_SERVER_ID HETZNER_SERVER_IP

    log_info "Server created: ID=$HETZNER_SERVER_ID, IP=$HETZNER_SERVER_IP"
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    local attempt=1

    log_warn "Waiting for SSH connectivity to $ip..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS -o ConnectTimeout=5 "root@$ip" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"
            return 0
        fi
        log_warn "Waiting for SSH... ($attempt/$max_attempts)"
        sleep 5
        attempt=$((attempt + 1))
    done

    log_error "Server failed to respond via SSH after $max_attempts attempts"
    return 1
}

# Wait for cloud-init to complete
wait_for_cloud_init() {
    local ip="$1"
    local max_attempts=${2:-60}
    local attempt=1

    log_warn "Waiting for cloud-init to complete..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS "root@$ip" "test -f /root/.cloud-init-complete" >/dev/null 2>&1; then
            log_info "Cloud-init completed"
            return 0
        fi
        log_warn "Cloud-init in progress... ($attempt/$max_attempts)"
        sleep 5
        attempt=$((attempt + 1))
    done

    log_error "Cloud-init did not complete after $max_attempts attempts"
    return 1
}

# Run a command on the server
run_server() {
    local ip="$1"
    local cmd="$2"
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

# Upload a file to the server
upload_file() {
    local ip="$1"
    local local_path="$2"
    local remote_path="$3"
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

# Start an interactive SSH session
interactive_session() {
    local ip="$1"
    local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

# Destroy a Hetzner server
destroy_server() {
    local server_id="$1"

    log_warn "Destroying server $server_id..."
    local response=$(hetzner_api DELETE "/servers/$server_id")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to destroy server: $response"
        return 1
    fi

    log_info "Server $server_id destroyed"
}

# List all Hetzner servers
list_servers() {
    local response=$(hetzner_api GET "/servers")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
servers = data.get('servers', [])
if not servers:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'TYPE':<10}\")
print('-' * 75)
for s in servers:
    name = s['name']
    sid = str(s['id'])
    status = s['status']
    ip = s.get('public_net', {}).get('ipv4', {}).get('ip', 'N/A')
    stype = s['server_type']['name']
    print(f'{name:<25} {sid:<12} {status:<12} {ip:<16} {stype:<10}')
" <<< "$response"
}
