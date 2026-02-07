#!/bin/bash
# Common bash functions for DigitalOcean spawn scripts

# Bash safety flags
set -euo pipefail

# ============================================================
# Provider-agnostic functions (shared with sprite/lib/common.sh)
# ============================================================

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

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
        read -p "$prompt" result
    elif echo -n "" > /dev/tty 2>/dev/null; then
        read -p "$prompt" result < /dev/tty
    else
        log_error "Cannot read input: no TTY available"
        return 1
    fi

    echo "$result"
}

# Listen on a port with netcat (handles busybox/Termux nc requiring -p flag)
nc_listen() {
    local port=$1
    shift
    if nc --help 2>&1 | grep -q "BusyBox\|busybox" || nc --help 2>&1 | grep -q "\-p "; then
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

# Validate model ID to prevent command injection
validate_model_id() {
    local model_id="$1"
    if [[ -z "$model_id" ]]; then return 0; fi
    if [[ ! "$model_id" =~ ^[a-zA-Z0-9/_:.-]+$ ]]; then
        log_error "Invalid model ID: contains unsafe characters"
        log_error "Model IDs should only contain: letters, numbers, /, -, _, :, ."
        return 1
    fi
    return 0
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

    if ! command -v nc &> /dev/null; then
        log_warn "netcat (nc) not found - OAuth server unavailable"
        return 1
    fi

    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"

    local oauth_dir=$(mktemp -d)
    local code_file="$oauth_dir/code"

    log_warn "Starting local OAuth server on port ${callback_port}..."

    (
        local success_response='HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>@keyframes checkmark{0%{transform:scale(0) rotate(-45deg);opacity:0}60%{transform:scale(1.2) rotate(-45deg);opacity:1}100%{transform:scale(1) rotate(-45deg);opacity:1}}@keyframes fadein{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}.check{width:80px;height:80px;border-radius:50%;background:#00d4aa22;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}.check::after{content:"";display:block;width:28px;height:14px;border-left:4px solid #00d4aa;border-bottom:4px solid #00d4aa;animation:checkmark .5s ease forwards}h1{color:#00d4aa;margin:0 0 8px;font-size:1.6rem}p{margin:0 0 6px;color:#ffffffcc;font-size:1rem}.sub{color:#ffffff66;font-size:.85rem;animation:fadein .5s ease .5s both}</style></head><body><div class="card"><div class="check"></div><h1>Authentication Successful!</h1><p>Redirecting back to terminal...</p><p class="sub">This tab will close automatically</p></div><script>setTimeout(function(){try{window.close()}catch(e){}setTimeout(function(){document.querySelector(".sub").textContent="You can safely close this tab"},500)},3000)</script></body></html>'

        while true; do
            local response_file=$(mktemp)
            echo -e "$success_response" > "$response_file"

            local request=$(nc_listen "$callback_port" < "$response_file" 2>/dev/null | head -1)
            local nc_status=$?
            rm -f "$response_file"

            if [[ "$nc_status" -ne 0 ]]; then
                break
            fi

            if [[ "$request" == *"/callback?code="* ]]; then
                local code=$(echo "$request" | sed -n 's/.*code=\([^ &]*\).*/\1/p')
                echo "$code" > "$code_file"
                break
            fi
        done
    ) </dev/null &
    local server_pid=$!

    sleep 1

    if ! kill -0 "$server_pid" 2>/dev/null; then
        log_warn "Failed to start OAuth server (port may be in use)"
        rm -rf "$oauth_dir"
        return 1
    fi

    log_warn "Opening browser to authenticate with OpenRouter..."
    open_browser "$auth_url"

    local timeout=120
    local elapsed=0
    while [[ ! -f "$code_file" ]] && [[ "$elapsed" -lt "$timeout" ]]; do
        sleep 1
        ((elapsed++))
    done

    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true

    if [[ ! -f "$code_file" ]]; then
        log_warn "OAuth timeout - no response received"
        rm -rf "$oauth_dir"
        return 1
    fi

    local oauth_code=$(cat "$code_file")
    rm -rf "$oauth_dir"

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

    local api_key=$(try_oauth_flow "$callback_port")

    if [[ -n "$api_key" ]]; then
        echo "$api_key"
        return 0
    fi

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
# DigitalOcean specific functions
# ============================================================

readonly DO_API_BASE="https://api.digitalocean.com/v2"
readonly SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

# Centralized curl wrapper for DigitalOcean API
do_api() {
    local method="$1"
    local endpoint="$2"
    local body="$3"

    local args=(
        -s
        -X "$method"
        -H "Authorization: Bearer ${DO_API_TOKEN}"
        -H "Content-Type: application/json"
    )

    if [[ -n "$body" ]]; then
        args+=(-d "$body")
    fi

    curl "${args[@]}" "${DO_API_BASE}${endpoint}"
}

# Ensure DO_API_TOKEN is available (env var -> config file -> prompt+save)
ensure_do_token() {
    # 1. Check environment variable
    if [[ -n "$DO_API_TOKEN" ]]; then
        log_info "Using DigitalOcean API token from environment"
        return 0
    fi

    # 2. Check config file
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/digitalocean.json"
    if [[ -f "$config_file" ]]; then
        local saved_token=$(python3 -c "import json; print(json.load(open('$config_file')).get('token',''))" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export DO_API_TOKEN="$saved_token"
            log_info "Using DigitalOcean API token from $config_file"
            return 0
        fi
    fi

    # 3. Prompt and save
    echo ""
    log_warn "DigitalOcean API Token Required"
    echo -e "${YELLOW}Get your token from: https://cloud.digitalocean.com/account/api/tokens${NC}"
    echo ""

    local token=$(safe_read "Enter your DigitalOcean API token: ") || return 1
    if [[ -z "$token" ]]; then
        log_error "API token is required"
        return 1
    fi

    # Validate token
    export DO_API_TOKEN="$token"
    local test_response=$(do_api GET "/account")
    if echo "$test_response" | grep -q '"id"'; then
        log_info "API token validated"
    else
        log_error "Invalid API token"
        unset DO_API_TOKEN
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

# Ensure SSH key exists locally and is registered with DigitalOcean
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
    local existing_fingerprint=$(ssh-keygen -lf "$pub_path" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://')
    local existing_keys=$(do_api GET "/account/keys")

    if echo "$existing_keys" | grep -q "$existing_fingerprint"; then
        log_info "SSH key already registered with DigitalOcean"
        return 0
    fi

    # Register the key
    log_warn "Registering SSH key with DigitalOcean..."
    local json_pub_key=$(python3 -c "import json; print(json.dumps('$pub_key'))" 2>/dev/null || echo "\"$pub_key\"")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response=$(do_api POST "/account/keys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        log_info "SSH key registered with DigitalOcean"
    else
        log_error "Failed to register SSH key: $register_response"
        return 1
    fi
}

# Get server name from env var or prompt
get_server_name() {
    if [[ -n "$DO_DROPLET_NAME" ]]; then
        log_info "Using droplet name from environment: $DO_DROPLET_NAME"
        echo "$DO_DROPLET_NAME"
        return 0
    fi

    local server_name=$(safe_read "Enter droplet name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Droplet name is required"
        log_warn "Set DO_DROPLET_NAME environment variable for non-interactive usage:"
        log_warn "  DO_DROPLET_NAME=dev-mk1 curl ... | bash"
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

# Create a DigitalOcean droplet with cloud-init
create_server() {
    local name="$1"
    local size="${DO_DROPLET_SIZE:-s-2vcpu-2gb}"
    local region="${DO_REGION:-nyc3}"
    local image="ubuntu-24-04-x64"

    log_warn "Creating DigitalOcean droplet '$name' (size: $size, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(do_api GET "/account/keys")
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
    'region': '$region',
    'size': '$size',
    'image': '$image',
    'ssh_keys': $ssh_key_ids,
    'user_data': json.loads($userdata_json),
    'backups': False,
    'monitoring': False
}
print(json.dumps(body))
")

    local response=$(do_api POST "/droplets" "$body")

    # Check for errors
    if echo "$response" | grep -q '"id"' && echo "$response" | grep -q '"droplet"'; then
        DO_DROPLET_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['droplet']['id'])")
        export DO_DROPLET_ID
        log_info "Droplet created: ID=$DO_DROPLET_ID"
    else
        local error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "Failed to create droplet: $error_msg"
        return 1
    fi

    # Wait for droplet to get an IP (poll until active)
    log_warn "Waiting for droplet to become active..."
    local max_attempts=60
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response=$(do_api GET "/droplets/$DO_DROPLET_ID")
        local status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['droplet']['status'])")

        if [[ "$status" == "active" ]]; then
            DO_SERVER_IP=$(echo "$status_response" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for net in data['droplet']['networks']['v4']:
    if net['type'] == 'public':
        print(net['ip_address'])
        break
")
            export DO_SERVER_IP
            log_info "Droplet active: IP=$DO_SERVER_IP"
            return 0
        fi

        log_warn "Droplet status: $status ($attempt/$max_attempts)"
        sleep 5
        ((attempt++))
    done

    log_error "Droplet did not become active in time"
    return 1
}

# Wait for SSH connectivity
verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    local attempt=1

    log_warn "Waiting for SSH connectivity to $ip..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        if ssh $SSH_OPTS -o ConnectTimeout=5 "root@$ip" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"
            return 0
        fi
        log_warn "Waiting for SSH... ($attempt/$max_attempts)"
        sleep 5
        ((attempt++))
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
    while [[ "$attempt" -le "$max_attempts" ]]; do
        if ssh $SSH_OPTS "root@$ip" "test -f /root/.cloud-init-complete" >/dev/null 2>&1; then
            log_info "Cloud-init completed"
            return 0
        fi
        log_warn "Cloud-init in progress... ($attempt/$max_attempts)"
        sleep 5
        ((attempt++))
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

# Destroy a DigitalOcean droplet
destroy_server() {
    local droplet_id="$1"

    log_warn "Destroying droplet $droplet_id..."
    local response=$(do_api DELETE "/droplets/$droplet_id")

    # DELETE returns 204 No Content on success (empty body)
    log_info "Droplet $droplet_id destroyed"
}

# List all DigitalOcean droplets
list_servers() {
    local response=$(do_api GET "/droplets")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
droplets = data.get('droplets', [])
if not droplets:
    print('No droplets found')
    sys.exit(0)
print(f\"{'NAME':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'SIZE':<15}\")
print('-' * 80)
for d in droplets:
    name = d['name']
    did = str(d['id'])
    status = d['status']
    ip = 'N/A'
    for net in d.get('networks', {}).get('v4', []):
        if net['type'] == 'public':
            ip = net['ip_address']
            break
    size = d['size_slug']
    print(f'{name:<25} {did:<12} {status:<12} {ip:<16} {size:<15}')
" <<< "$response"
}
