#!/bin/bash
# Common bash functions for Lambda Cloud spawn scripts
# Uses Lambda Cloud REST API — https://docs.lambdalabs.com/cloud/api/

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
# Lambda Cloud specific functions
# ============================================================

LAMBDA_API_BASE="https://cloud.lambdalabs.com/api/v1"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

lambda_api() {
    local method="$1" endpoint="$2" body="$3"
    local args=(-s -X "$method" -H "Authorization: Bearer ${LAMBDA_API_KEY}" -H "Content-Type: application/json")
    if [[ -n "$body" ]]; then args+=(-d "$body"); fi
    curl "${args[@]}" "${LAMBDA_API_BASE}${endpoint}"
}

ensure_lambda_token() {
    if [[ -n "${LAMBDA_API_KEY:-}" ]]; then
        log_info "Using Lambda API key from environment"; return 0
    fi
    local config_dir="$HOME/.config/spawn" config_file="$config_dir/lambda.json"
    if [[ -f "$config_file" ]]; then
        local saved_key=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_key',''))" 2>/dev/null)
        if [[ -n "$saved_key" ]]; then
            export LAMBDA_API_KEY="$saved_key"
            log_info "Using Lambda API key from $config_file"; return 0
        fi
    fi
    echo ""; log_warn "Lambda Cloud API Key Required"
    echo -e "${YELLOW}Get your API key from: https://cloud.lambdalabs.com/api-keys${NC}"; echo ""
    local api_key=$(safe_read "Enter your Lambda API key: ") || return 1
    if [[ -z "$api_key" ]]; then log_error "API key is required"; return 1; fi
    export LAMBDA_API_KEY="$api_key"
    local test_response=$(lambda_api GET "/instances")
    if echo "$test_response" | grep -q '"error"'; then
        log_error "Invalid API key"; unset LAMBDA_API_KEY; return 1
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
    local key_path="$HOME/.ssh/id_ed25519" pub_path="${key_path}.pub"
    if [[ ! -f "$key_path" ]]; then
        log_warn "Generating SSH key..."
        mkdir -p "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$key_path" -N "" -q
        log_info "SSH key generated at $key_path"
    fi
    local pub_key=$(cat "$pub_path")
    # Check if key is already registered
    local existing_keys=$(lambda_api GET "/ssh-keys")
    local existing_fingerprint=$(ssh-keygen -lf "$pub_path" -E md5 2>/dev/null | awk '{print $2}' | sed 's/MD5://')
    if echo "$existing_keys" | grep -q "$existing_fingerprint"; then
        log_info "SSH key already registered with Lambda Cloud"; return 0
    fi
    log_warn "Registering SSH key with Lambda Cloud..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local json_pub_key=$(python3 -c "import json; print(json.dumps('$pub_key'))" 2>/dev/null || echo "\"$pub_key\"")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response=$(lambda_api POST "/ssh-keys" "$register_body")
    if echo "$register_response" | grep -q '"id"'; then
        log_info "SSH key registered with Lambda Cloud"
    else log_error "Failed to register SSH key: $register_response"; return 1; fi
}

get_server_name() {
    if [[ -n "${LAMBDA_SERVER_NAME:-}" ]]; then
        log_info "Using server name from environment: $LAMBDA_SERVER_NAME"
        echo "$LAMBDA_SERVER_NAME"; return 0
    fi
    local server_name=$(safe_read "Enter instance name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Instance name is required"
        log_warn "Set LAMBDA_SERVER_NAME environment variable for non-interactive usage"; return 1
    fi
    echo "$server_name"
}

create_server() {
    local name="$1"
    local instance_type="${LAMBDA_INSTANCE_TYPE:-gpu_1x_a10}"
    local region="${LAMBDA_REGION:-us-east-1}"

    log_warn "Creating Lambda instance '$name' (type: $instance_type, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(lambda_api GET "/ssh-keys")
    local ssh_key_names=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
names = [k['name'] for k in data.get('data', [])]
print(json.dumps(names))
" <<< "$ssh_keys_response")

    local body=$(python3 -c "
import json
body = {
    'name': '$name',
    'instance_type_name': '$instance_type',
    'region_name': '$region',
    'ssh_key_names': $ssh_key_names
}
print(json.dumps(body))
")

    local response=$(lambda_api POST "/instance-operations/launch" "$body")

    if echo "$response" | grep -q '"instance_ids"'; then
        LAMBDA_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['instance_ids'][0])")
        export LAMBDA_SERVER_ID
        log_info "Instance launched: ID=$LAMBDA_SERVER_ID"
    else
        local error_msg=$(echo "$response" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read())
print(d.get('error', {}).get('message', d.get('error', 'Unknown error')))
" 2>/dev/null || echo "$response")
        log_error "Failed to create instance: $error_msg"
        return 1
    fi

    # Wait for instance to become active and get IP
    log_warn "Waiting for instance to become active..."
    local max_attempts=60 attempt=1
    while [[ $attempt -le $max_attempts ]]; do
        local status_response=$(lambda_api GET "/instances/$LAMBDA_SERVER_ID")
        local status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['status'])" 2>/dev/null)

        if [[ "$status" == "active" ]]; then
            LAMBDA_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['ip'])")
            export LAMBDA_SERVER_IP
            log_info "Instance active: IP=$LAMBDA_SERVER_IP"
            return 0
        fi
        log_warn "Instance status: $status ($attempt/$max_attempts)"
        sleep 10; attempt=$((attempt + 1))
    done
    log_error "Instance did not become active in time"; return 1
}

verify_server_connectivity() {
    local ip="$1" max_attempts=${2:-30} attempt=1
    log_warn "Waiting for SSH connectivity to $ip..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS -o ConnectTimeout=5 "ubuntu@$ip" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"; return 0
        fi
        log_warn "Waiting for SSH... ($attempt/$max_attempts)"; sleep 5; attempt=$((attempt + 1))
    done
    log_error "Server failed to respond via SSH after $max_attempts attempts"; return 1
}

wait_for_cloud_init() {
    local ip="$1"
    # Lambda instances come pre-provisioned, install tools manually
    log_warn "Installing base tools..."
    ssh $SSH_OPTS "ubuntu@$ip" "sudo apt-get update -y && sudo apt-get install -y curl unzip git zsh" >/dev/null 2>&1

    # Install Bun
    log_warn "Installing Bun..."
    ssh $SSH_OPTS "ubuntu@$ip" "curl -fsSL https://bun.sh/install | bash" >/dev/null 2>&1

    # Install Claude Code
    log_warn "Installing Claude Code..."
    ssh $SSH_OPTS "ubuntu@$ip" "curl -fsSL https://claude.ai/install.sh | bash" >/dev/null 2>&1

    # Configure PATH
    ssh $SSH_OPTS "ubuntu@$ip" "echo 'export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"' >> ~/.bashrc && echo 'export PATH=\"\$HOME/.claude/local/bin:\$HOME/.bun/bin:\$PATH\"' >> ~/.zshrc" >/dev/null 2>&1

    log_info "Base tools installed"
}

# Lambda uses 'ubuntu' user
run_server() { local ip="$1" cmd="$2"; ssh $SSH_OPTS "ubuntu@$ip" "$cmd"; }
upload_file() { local ip="$1" local_path="$2" remote_path="$3"; scp $SSH_OPTS "$local_path" "ubuntu@$ip:$remote_path"; }
interactive_session() { local ip="$1" cmd="$2"; ssh -t $SSH_OPTS "ubuntu@$ip" "$cmd"; }

destroy_server() {
    local server_id="$1"
    log_warn "Terminating instance $server_id..."
    lambda_api POST "/instance-operations/terminate" "{\"instance_ids\":[\"$server_id\"]}"
    log_info "Instance $server_id terminated"
}

list_servers() {
    local response=$(lambda_api GET "/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('data', [])
if not instances: print('No instances found'); sys.exit(0)
print(f\"{'NAME':<25} {'ID':<40} {'STATUS':<12} {'IP':<16} {'TYPE':<20}\")
print('-' * 113)
for i in instances:
    name = i.get('name','N/A'); iid = i['id']; status = i['status']
    ip = i.get('ip', 'N/A'); itype = i.get('instance_type',{}).get('name','N/A')
    print(f'{name:<25} {iid:<40} {status:<12} {ip:<16} {itype:<20}')
" <<< "$response"
}
