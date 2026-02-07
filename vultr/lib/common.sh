#!/bin/bash
# Common bash functions for Vultr spawn scripts

# Bash safety flags
set -euo pipefail

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
# Vultr specific functions
# ============================================================

readonly VULTR_API_BASE="https://api.vultr.com/v2"
# SSH_OPTS is now defined in shared/common.sh

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

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    # Check if already registered
    local fingerprint=$(get_ssh_fingerprint "$pub_path")
    local existing_keys=$(vultr_api GET "/ssh-keys")
    if echo "$existing_keys" | grep -q "$fingerprint"; then
        log_info "SSH key already registered with Vultr"
        return 0
    fi

    # Register the key
    log_warn "Registering SSH key with Vultr..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local pub_key=$(cat "$pub_path")
    local json_pub_key=$(json_escape "$pub_key")
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
    local ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

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
    generic_ssh_wait "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

wait_for_cloud_init() {
    local ip="$1"
    local max_attempts=${2:-60}
    generic_ssh_wait "$ip" "$SSH_OPTS" "test -f /root/.cloud-init-complete" "cloud-init" "$max_attempts" 5
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
