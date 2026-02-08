#!/bin/bash
# Common bash functions for Lambda Cloud spawn scripts
# Uses Lambda Cloud REST API — https://docs.lambdalabs.com/cloud/api/

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
# Lambda Cloud specific functions
# ============================================================

LAMBDA_API_BASE="https://cloud.lambdalabs.com/api/v1"
# SSH_OPTS is now defined in shared/common.sh

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
        local saved_key 2>/dev/null)
        saved_key=$(python3 -c "import json; print(json.load(open('$config_file')).get('api_key',''))"
        if [[ -n "$saved_key" ]]; then
            export LAMBDA_API_KEY="$saved_key"
            log_info "Using Lambda API key from $config_file"; return 0
        fi
    fi
    echo ""; log_warn "Lambda Cloud API Key Required"
    log_warn "Get your API key from: https://cloud.lambdalabs.com/api-keys"; echo ""
    local api_key
    api_key=$(validated_read "Enter your Lambda API key: " validate_api_token) || return 1
    export LAMBDA_API_KEY="$api_key"
    local test_response
    test_response=$(lambda_api GET "/instances")
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
    local key_path="$HOME/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    local pub_key
    pub_key=$(cat "$pub_path")
    # Check if key is already registered
    local existing_keys
    existing_keys=$(lambda_api GET "/ssh-keys")
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "$pub_path")
    if echo "$existing_keys" | grep -q "$fingerprint"; then
        log_info "SSH key already registered with Lambda Cloud"
        return 0
    fi

    log_warn "Registering SSH key with Lambda Cloud..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local json_pub_key
    json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response
    register_response=$(lambda_api POST "/ssh-keys" "$register_body")
    if echo "$register_response" | grep -q '"id"'; then
        log_info "SSH key registered with Lambda Cloud"
    else
        log_error "Failed to register SSH key: $register_response"
        return 1
    fi
}

get_server_name() {
    if [[ -n "${LAMBDA_SERVER_NAME:-}" ]]; then
        log_info "Using server name from environment: $LAMBDA_SERVER_NAME"
        echo "$LAMBDA_SERVER_NAME"; return 0
    fi
    local server_name
    server_name=$(safe_read "Enter instance name: ")
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
    local ssh_keys_response
    ssh_keys_response=$(lambda_api GET "/ssh-keys")
    local ssh_key_names
    ssh_key_names=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
names = [k['name'] for k in data.get('data', [])]
print(json.dumps(names))
" <<< "$ssh_keys_response")

    local body
    body=$(python3 -c "
import json
body = {
    'name': '$name',
    'instance_type_name': '$instance_type',
    'region_name': '$region',
    'ssh_key_names': $ssh_key_names
}
print(json.dumps(body))
")

    local response
    response=$(lambda_api POST "/instance-operations/launch" "$body")

    if echo "$response" | grep -q '"instance_ids"'; then
        LAMBDA_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['instance_ids'][0])")
        export LAMBDA_SERVER_ID
        log_info "Instance launched: ID=$LAMBDA_SERVER_ID"
    else
        local error_msg
        error_msg=$(echo "$response" | python3 -c "
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
        local status_response
        status_response=$(lambda_api GET "/instances/$LAMBDA_SERVER_ID")
        local status 2>/dev/null)
        status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['data']['status'])"

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
        # SSH_OPTS is defined in shared/common.sh
        # shellcheck disable=SC2154
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
    local response
    response=$(lambda_api GET "/instances")
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
