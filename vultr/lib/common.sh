#!/bin/bash
# Common bash functions for Vultr spawn scripts

# Bash safety flags
set -euo pipefail

# ============================================================
# Provider-agnostic functions (shared with sprite/lib/common.sh)
# ============================================================

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m'

log_info() { echo -e "${GREEN}$1${NC}" >&2; }
log_warn() { echo -e "${YELLOW}$1${NC}" >&2; }
log_error() { echo -e "${RED}$1${NC}" >&2; }

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

nc_listen() {
    local port=$1; shift
    if nc --help 2>&1 | grep -q "BusyBox\|busybox" || nc --help 2>&1 | grep -q "\-p "; then
        nc -l -p "$port" "$@"
    else
        nc -l "$port" "$@"
    fi
}

open_browser() {
    local url=$1
    if command -v termux-open-url &> /dev/null; then termux-open-url "$url" </dev/null
    elif command -v open &> /dev/null; then open "$url" </dev/null
    elif command -v xdg-open &> /dev/null; then xdg-open "$url" </dev/null
    else log_warn "Please open: ${url}"; fi
}

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
            if [[ "$confirm" =~ ^[Yy]$ ]]; then break; else api_key=""; fi
        fi
    done
    log_info "API key accepted!"
    echo "$api_key"
}

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
            if [[ "$nc_status" -ne 0 ]]; then break; fi
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
    local timeout=120 elapsed=0
    while [[ ! -f "$code_file" ]] && [[ "$elapsed" -lt "$timeout" ]]; do sleep 1; ((elapsed++)); done
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
        -H "Content-Type: application/json" -d "{\"code\": \"$oauth_code\"}")
    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')
    if [[ -z "$api_key" ]]; then
        log_error "Failed to exchange OAuth code: ${key_response}"
        return 1
    fi
    log_info "Successfully obtained OpenRouter API key via OAuth!"
    echo "$api_key"
}

get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}
    local api_key=$(try_oauth_flow "$callback_port")
    if [[ -n "$api_key" ]]; then echo "$api_key"; return 0; fi
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
        echo "$api_key"; return 0
    else
        log_error "Authentication cancelled by user"; return 1
    fi
}

# ============================================================
# Vultr specific functions
# ============================================================

readonly VULTR_API_BASE="https://api.vultr.com/v2"
readonly SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

vultr_api() {
    local method="$1"
    local endpoint="$2"
    local body="$3"
    local args=(-s -X "$method" -H "Authorization: Bearer ${VULTR_API_KEY}" -H "Content-Type: application/json")
    if [[ -n "$body" ]]; then args+=(-d "$body"); fi
    curl "${args[@]}" "${VULTR_API_BASE}${endpoint}"
}

ensure_vultr_token() {
    if [[ -n "$VULTR_API_KEY" ]]; then
        log_info "Using Vultr API key from environment"
        return 0
    fi
    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/vultr.json"
    if [[ -f "$config_file" ]]; then
        local saved_key=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_key',''))" 2>/dev/null)
        if [[ -n "$saved_key" ]]; then
            export VULTR_API_KEY="$saved_key"
            log_info "Using Vultr API key from $config_file"
            return 0
        fi
    fi
    echo ""
    log_warn "Vultr API Key Required"
    echo -e "${YELLOW}Get your API key from: https://my.vultr.com/settings/#settingsapi${NC}"
    echo ""
    local api_key=$(safe_read "Enter your Vultr API key: ") || return 1
    if [[ -z "$api_key" ]]; then
        log_error "API key is required"
        return 1
    fi
    export VULTR_API_KEY="$api_key"
    local test_response=$(vultr_api GET "/account")
    if echo "$test_response" | grep -q '"account"'; then
        log_info "API key validated"
    else
        log_error "Invalid API key"
        unset VULTR_API_KEY
        return 1
    fi
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "api_key": "$api_key"
}
EOF
    chmod 600 "$config_file"
    log_info "API key saved to $config_file"
}

ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"
    if [[ ! -f "$key_path" ]]; then
        log_warn "Generating SSH key..."
        mkdir -p "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$key_path" -N "" -q
        log_info "SSH key generated at $key_path"
    fi
    local pub_key=$(cat "$pub_path")
    local existing_keys=$(vultr_api GET "/ssh-keys")
    local existing_fingerprint=$(ssh-keygen -lf "$pub_path" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://')
    if echo "$existing_keys" | grep -q "$existing_fingerprint"; then
        log_info "SSH key already registered with Vultr"
        return 0
    fi
    log_warn "Registering SSH key with Vultr..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local json_pub_key=$(python3 -c "import json; print(json.dumps('$pub_key'))" 2>/dev/null || echo "\"$pub_key\"")
    local register_body="{\"name\":\"$key_name\",\"ssh_key\":$json_pub_key}"
    local register_response=$(vultr_api POST "/ssh-keys" "$register_body")
    if echo "$register_response" | grep -q '"ssh_key"'; then
        log_info "SSH key registered with Vultr"
    else
        log_error "Failed to register SSH key: $register_response"
        return 1
    fi
}

get_server_name() {
    if [[ -n "$VULTR_SERVER_NAME" ]]; then
        log_info "Using server name from environment: $VULTR_SERVER_NAME"
        echo "$VULTR_SERVER_NAME"
        return 0
    fi
    local server_name=$(safe_read "Enter server name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Server name is required"
        log_warn "Set VULTR_SERVER_NAME environment variable for non-interactive usage"
        return 1
    fi
    echo "$server_name"
}

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
  - su - root -c 'curl -fsSL https://bun.sh/install | bash'
  - su - root -c 'curl -fsSL https://claude.ai/install.sh | bash'
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.bashrc
  - echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /root/.zshrc
  - touch /root/.cloud-init-complete
CLOUD_INIT_EOF
}

create_server() {
    local name="$1"
    local plan="${VULTR_PLAN:-vc2-1c-2gb}"
    local region="${VULTR_REGION:-ewr}"
    # Ubuntu 24.04 x64 OS ID
    local os_id="${VULTR_OS_ID:-2284}"

    log_warn "Creating Vultr instance '$name' (plan: $plan, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(vultr_api GET "/ssh-keys")
    local ssh_key_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = [k['id'] for k in data.get('ssh_keys', [])]
print(json.dumps(ids))
" <<< "$ssh_keys_response")

    local userdata=$(get_cloud_init_userdata)
    local userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    local body=$(python3 -c "
import json
body = {
    'label': '$name',
    'hostname': '$name',
    'region': '$region',
    'plan': '$plan',
    'os_id': $os_id,
    'sshkey_id': $ssh_key_ids,
    'user_data': '$userdata_b64',
    'backups': 'disabled'
}
print(json.dumps(body))
")

    local response=$(vultr_api POST "/instances" "$body")

    if echo "$response" | grep -q '"instance"'; then
        VULTR_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['id'])")
        export VULTR_SERVER_ID
        log_info "Instance created: ID=$VULTR_SERVER_ID"
    else
        local error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "Failed to create instance: $error_msg"
        return 1
    fi

    # Wait for instance to get an IP
    log_warn "Waiting for instance to become active..."
    local max_attempts=60
    local attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response=$(vultr_api GET "/instances/$VULTR_SERVER_ID")
        local status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['status'])")
        local power=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['power_status'])")

        if [[ "$status" == "active" && "$power" == "running" ]]; then
            VULTR_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['main_ip'])")
            export VULTR_SERVER_IP
            log_info "Instance active: IP=$VULTR_SERVER_IP"
            return 0
        fi

        log_warn "Instance status: $status/$power ($attempt/$max_attempts)"
        sleep 5
        ((attempt++))
    done

    log_error "Instance did not become active in time"
    return 1
}

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

run_server() {
    local ip="$1"; local cmd="$2"
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

upload_file() {
    local ip="$1"; local local_path="$2"; local remote_path="$3"
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

interactive_session() {
    local ip="$1"; local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

destroy_server() {
    local server_id="$1"
    log_warn "Destroying instance $server_id..."
    vultr_api DELETE "/instances/$server_id"
    log_info "Instance $server_id destroyed"
}

list_servers() {
    local response=$(vultr_api GET "/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('instances', [])
if not instances:
    print('No instances found')
    sys.exit(0)
print(f\"{'LABEL':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'PLAN':<15}\")
print('-' * 108)
for i in instances:
    label = i.get('label', 'N/A')
    iid = i['id']
    status = i['status']
    ip = i.get('main_ip', 'N/A')
    plan = i['plan']
    print(f'{label:<25} {iid:<40} {status:<12} {ip:<16} {plan:<15}')
" <<< "$response"
}
