#!/bin/bash
# Common bash functions for Hetzner Cloud spawn scripts

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../shared/common.sh" || {
    echo "ERROR: Failed to load shared/common.sh" >&2
    exit 1
}

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# Hetzner Cloud specific functions
# ============================================================

readonly HETZNER_API_BASE="https://api.hetzner.cloud/v1"
readonly SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

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
