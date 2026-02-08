#!/bin/bash
# Common bash functions for DigitalOcean spawn scripts

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
# DigitalOcean specific functions
# ============================================================

readonly DO_API_BASE="https://api.digitalocean.com/v2"
# SSH_OPTS is now defined in shared/common.sh

# Centralized curl wrapper for DigitalOcean API
do_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    generic_cloud_api "$DO_API_BASE" "$DO_API_TOKEN" "$method" "$endpoint" "$body"
}

# Ensure DO_API_TOKEN is available (env var -> config file -> prompt+save)
ensure_do_token() {
    # Check Python 3 is available (required for JSON parsing)
    check_python_available || return 1

    # 1. Check environment variable
    if [[ -n "${DO_API_TOKEN:-}" ]]; then
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

    local token
    token=$(validated_read "Enter your DigitalOcean API token: " validate_api_token) || return 1

    # Validate token
    export DO_API_TOKEN="$token"
    local response=$(do_api GET "/account")
    if echo "$response" | grep -q '"id"'; then
        log_info "API token validated"
    else
        log_error "Authentication failed: Invalid DigitalOcean API token"

        # Parse error details if available
        local error_msg=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','No details available'))" 2>/dev/null || echo "Unable to parse error")
        log_error "API Error: $error_msg"

        log_warn "Remediation steps:"
        log_warn "  1. Verify token at: https://cloud.digitalocean.com/account/api/tokens"
        log_warn "  2. Ensure the token has read/write permissions"
        log_warn "  3. Check token hasn't expired or been revoked"
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

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    # Check if already registered
    local fingerprint=$(get_ssh_fingerprint "$pub_path")
    local existing_keys=$(do_api GET "/account/keys")
    if echo "$existing_keys" | grep -q "$fingerprint"; then
        log_info "SSH key already registered with DigitalOcean"
        return 0
    fi

    # Register the key
    log_warn "Registering SSH key with DigitalOcean..."
    local key_name="spawn-$(hostname)-$(date +%s)"
    local pub_key=$(cat "$pub_path")
    local json_pub_key=$(json_escape "$pub_key")
    local register_body="{\"name\":\"$key_name\",\"public_key\":$json_pub_key}"
    local register_response=$(do_api POST "/account/keys" "$register_body")

    if echo "$register_response" | grep -q '"id"'; then
        log_info "SSH key registered with DigitalOcean"
    else
        log_error "Failed to register SSH key with DigitalOcean"

        # Parse error details
        local error_msg=$(echo "$register_response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('message','Unknown error'))" 2>/dev/null || echo "$register_response")
        log_error "API Error: $error_msg"

        log_warn "Common causes:"
        log_warn "  - SSH key already registered (check: doctl compute ssh-key list)"
        log_warn "  - Invalid SSH key format (must be valid ed25519 public key)"
        log_warn "  - API token lacks write permissions"
        return 1
    fi
}

# Get server name from env var or prompt
get_server_name() {
    local server_name
    server_name=$(get_resource_name "DO_DROPLET_NAME" "Enter droplet name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# get_cloud_init_userdata is now defined in shared/common.sh

# Create a DigitalOcean droplet with cloud-init
create_server() {
    local name="$1"
    local size="${DO_DROPLET_SIZE:-s-2vcpu-2gb}"
    local region="${DO_REGION:-nyc3}"
    local image="ubuntu-24-04-x64"

    log_warn "Creating DigitalOcean droplet '$name' (size: $size, region: $region)..."

    # Get all SSH key IDs
    local ssh_keys_response=$(do_api GET "/account/keys")
    local ssh_key_ids=$(extract_ssh_key_ids "$ssh_keys_response" "ssh_keys")

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
        log_error "Failed to create DigitalOcean droplet"

        # Parse error details
        local error_msg=$(echo "$response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('message','Unknown error'))" 2>/dev/null || echo "$response")
        log_error "API Error: $error_msg"

        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Region/size unavailable (try different DO_REGION or DO_DROPLET_SIZE)"
        log_warn "  - Droplet limit reached (check account limits)"
        log_warn "  - Invalid cloud-init userdata"
        log_warn "Remediation: Check https://cloud.digitalocean.com/droplets"
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
    generic_ssh_wait "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
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
