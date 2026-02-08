#!/bin/bash
# Common bash functions for Linode (Akamai) spawn scripts

# Bash safety flags
set -euo pipefail

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
# Linode (Akamai) specific functions
# ============================================================

readonly LINODE_API_BASE="https://api.linode.com/v4"
# SSH_OPTS is now defined in shared/common.sh

linode_api() {
    local method="$1" endpoint="$2" body="${3:-}"
    generic_cloud_api "$LINODE_API_BASE" "$LINODE_API_TOKEN" "$method" "$endpoint" "$body"
}

ensure_linode_token() {
    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    if [[ -n "$LINODE_API_TOKEN" ]]; then
        log_info "Using Linode API token from environment"; return 0
    fi
    local config_dir="$HOME/.config/spawn" config_file="$config_dir/linode.json"
    if [[ -f "$config_file" ]]; then
        local saved_token=$(python3 -c "import json; print(json.load(open('$config_file')).get('token',''))" 2>/dev/null)
        if [[ -n "$saved_token" ]]; then
            export LINODE_API_TOKEN="$saved_token"
            log_info "Using Linode API token from $config_file"; return 0
        fi
    fi
    echo ""; log_warn "Linode API Token Required"
    echo -e "${YELLOW}Get your token from: https://cloud.linode.com/profile/tokens${NC}"; echo ""
    local token=$(safe_read "Enter your Linode API token: ") || return 1
    if [[ -z "$token" ]]; then
        log_error "API token cannot be empty"
        log_warn "For non-interactive usage, set: LINODE_API_TOKEN=your-token"
        return 1
    fi
    export LINODE_API_TOKEN="$token"
    local response=$(linode_api GET "/profile")
    if echo "$response" | grep -q '"username"'; then
        log_info "API token validated"
    else
        log_error "Authentication failed: Invalid Linode API token"

        # Parse error details
        local error_msg=$(echo "$response" | python3 -c "import json,sys; errs=json.loads(sys.stdin.read()).get('errors',[]); print(errs[0].get('reason','No details') if errs else 'Unable to parse')" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"

        log_warn "Remediation steps:"
        log_warn "  1. Verify token at: https://cloud.linode.com/profile/tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't expired or been revoked"
        unset LINODE_API_TOKEN
        return 1
    fi
    mkdir -p "$config_dir"
    cat > "$config_file" << EOF
{
  "token": "$token"
}
EOF
    chmod 600 "$config_file"
    log_info "API token saved to $config_file"
}

ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519" pub_path="${key_path}.pub"
    generate_ssh_key_if_missing "$key_path"
    local fingerprint=$(get_ssh_fingerprint "$pub_path")
    local existing_keys=$(linode_api GET "/profile/sshkeys")
    if echo "$existing_keys" | grep -q "$fingerprint"; then
        log_info "SSH key already registered with Linode"; return 0
    fi
    log_warn "Registering SSH key with Linode..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local pub_key=$(cat "$pub_path")
    local json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"label\":\"$key_name\",\"ssh_key\":$json_pub_key}"
    local register_response=$(linode_api POST "/profile/sshkeys" "$register_body")
    if echo "$register_response" | grep -q '"id"'; then
        log_info "SSH key registered with Linode"
    else
        log_error "Failed to register SSH key with Linode"

        # Parse error details
        local error_msg=$(echo "$register_response" | python3 -c "import json,sys; errs=json.loads(sys.stdin.read()).get('errors',[]); print('; '.join(e.get('reason','Unknown') for e in errs) if errs else 'Unknown error')" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

get_server_name() {
    if [[ -n "$LINODE_SERVER_NAME" ]]; then
        log_info "Using server name from environment: $LINODE_SERVER_NAME"
        if ! validate_server_name "$LINODE_SERVER_NAME"; then
            return 1
        fi
        echo "$LINODE_SERVER_NAME"; return 0
    fi
    local server_name=$(safe_read "Enter Linode label: ")
    if [[ -z "$server_name" ]]; then
        log_error "Server name is required"
        log_warn "Set LINODE_SERVER_NAME environment variable for non-interactive usage"; return 1
    fi
    if ! validate_server_name "$server_name"; then
        return 1
    fi
    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

create_server() {
    local name="$1"
    local type="${LINODE_TYPE:-g6-standard-1}"
    local region="${LINODE_REGION:-us-east}"
    local image="linode/ubuntu24.04"

    log_warn "Creating Linode '$name' (type: $type, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(linode_api GET "/profile/sshkeys")
    local authorized_keys=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
keys = [k['ssh_key'] for k in data.get('data', [])]
print(json.dumps(keys))
" <<< "$ssh_keys_response")

    local userdata=$(get_cloud_init_userdata)
    local userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    # Generate a root password (required by Linode API)
    local root_pass=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#$') for _ in range(32)))")

    local body=$(python3 -c "
import json
body = {
    'label': '$name',
    'region': '$region',
    'type': '$type',
    'image': '$image',
    'authorized_keys': $authorized_keys,
    'root_pass': '$root_pass',
    'metadata': {
        'user_data': '$userdata_b64'
    },
    'booted': True
}
print(json.dumps(body))
")

    local response=$(linode_api POST "/linode/instances" "$body")

    if echo "$response" | grep -q '"id"' && ! echo "$response" | grep -q '"errors"'; then
        LINODE_SERVER_ID=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])")
        export LINODE_SERVER_ID
        log_info "Linode created: ID=$LINODE_SERVER_ID"
    else
        log_error "Failed to create Linode instance"

        # Parse error details
        local error_msg=$(echo "$response" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read())
errs = d.get('errors', [])
print('; '.join(e.get('reason','Unknown') for e in errs) if errs else 'Unknown error')
" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Type/region unavailable (try different LINODE_TYPE or LINODE_REGION)"
        log_warn "  - Instance limit reached"
        log_warn "  - Invalid cloud-init metadata"
        log_warn "Remediation: Check https://cloud.linode.com/"
        return 1
    fi

    # Wait for Linode to become running and get IP
    log_warn "Waiting for Linode to become active..."
    local max_attempts=60 attempt=1
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local status_response=$(linode_api GET "/linode/instances/$LINODE_SERVER_ID")
        local status=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['status'])")

        if [[ "$status" == "running" ]]; then
            LINODE_SERVER_IP=$(echo "$status_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['ipv4'][0])")
            export LINODE_SERVER_IP
            log_info "Linode active: IP=$LINODE_SERVER_IP"
            return 0
        fi
        log_warn "Linode status: $status ($attempt/$max_attempts)"
        sleep 5; ((attempt++))
    done
    log_error "Linode did not become active in time"; return 1
}

verify_server_connectivity() {
    local ip="$1" max_attempts=${2:-30}
    generic_ssh_wait "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}


run_server() { local ip="$1" cmd="$2"; ssh $SSH_OPTS "root@$ip" "$cmd"; }
upload_file() { local ip="$1" local_path="$2" remote_path="$3"; scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"; }
interactive_session() { local ip="$1" cmd="$2"; ssh -t $SSH_OPTS "root@$ip" "$cmd"; }

destroy_server() {
    local server_id="$1"
    log_warn "Destroying Linode $server_id..."
    linode_api DELETE "/linode/instances/$server_id"
    log_info "Linode $server_id destroyed"
}

list_servers() {
    local response=$(linode_api GET "/linode/instances")
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
instances = data.get('data', [])
if not instances: print('No Linodes found'); sys.exit(0)
print(f\"{'LABEL':<25} {'ID':<12} {'STATUS':<12} {'IP':<16} {'TYPE':<15}\")
print('-' * 80)
for i in instances:
    label = i.get('label','N/A'); lid = str(i['id']); status = i['status']
    ip = i['ipv4'][0] if i.get('ipv4') else 'N/A'; ltype = i['type']
    print(f'{label:<25} {lid:<12} {status:<12} {ip:<16} {ltype:<15}')
" <<< "$response"
}
