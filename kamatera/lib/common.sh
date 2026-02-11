#!/bin/bash
# Common bash functions for Kamatera spawn scripts

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
# Kamatera specific functions
# ============================================================

readonly KAMATERA_API_BASE="https://cloudcli.cloudwm.com"

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}
KAMATERA_COMMAND_TIMEOUT=${KAMATERA_COMMAND_TIMEOUT:-600}  # 10 minutes for async commands

# Kamatera API wrapper - uses AuthClientId/AuthSecret headers instead of Bearer token
# Delegates to generic_cloud_api_custom_auth for retry logic and error handling
kamatera_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    local max_retries="${4:-3}"
    generic_cloud_api_custom_auth "$KAMATERA_API_BASE" "$method" "$endpoint" "$body" "$max_retries" \
        -H "AuthClientId: ${KAMATERA_API_CLIENT_ID}" \
        -H "AuthSecret: ${KAMATERA_API_SECRET}"
}

# Try to load Kamatera credentials from config file
# Returns 0 if loaded, 1 otherwise
_load_kamatera_config() {
    local config_file="$1"
    [[ -f "$config_file" ]] || return 1

    local creds
    creds=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get('api_client_id', ''))
print(d.get('api_secret', ''))
" "$config_file" 2>/dev/null) || return 1

    [[ -n "${creds}" ]] || return 1

    local saved_client_id saved_secret
    { read -r saved_client_id; read -r saved_secret; } <<< "${creds}"
    if [[ -n "$saved_client_id" ]] && [[ -n "$saved_secret" ]]; then
        export KAMATERA_API_CLIENT_ID="$saved_client_id"
        export KAMATERA_API_SECRET="$saved_secret"
        log_info "Using Kamatera API credentials from $config_file"
        return 0
    fi
    return 1
}

# Validate Kamatera credentials with a test API call
# Returns 0 if valid, 1 otherwise (unsets credentials on failure)
_validate_kamatera_credentials() {
    local response
    response=$(kamatera_api POST "/service/server/info" '{"name":"__test__"}')
    if printf '%s' "$response" | grep -qi "authentication failed\|unauthorized\|invalid.*auth"; then
        log_error "Authentication failed: Invalid Kamatera API credentials"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://console.kamatera.com/keys"
        log_warn "  2. Ensure the API key has appropriate permissions"
        unset KAMATERA_API_CLIENT_ID
        unset KAMATERA_API_SECRET
        return 1
    fi
    return 0
}

ensure_kamatera_token() {
    check_python_available || return 1

    if [[ -n "${KAMATERA_API_CLIENT_ID:-}" ]] && [[ -n "${KAMATERA_API_SECRET:-}" ]]; then
        log_info "Using Kamatera API credentials from environment"
        return 0
    fi

    local config_file="$HOME/.config/spawn/kamatera.json"

    if _load_kamatera_config "$config_file"; then
        return 0
    fi

    echo ""
    log_warn "Kamatera API Credentials Required"
    log_warn "Get your API keys from: https://console.kamatera.com/keys"
    echo ""

    local client_id
    client_id=$(validated_read "Enter your Kamatera API Client ID: " validate_api_token) || return 1

    local secret
    secret=$(validated_read "Enter your Kamatera API Secret: " validate_api_token) || return 1

    export KAMATERA_API_CLIENT_ID="$client_id"
    export KAMATERA_API_SECRET="$secret"

    _validate_kamatera_credentials || return 1
    log_info "API credentials validated"

    local config_dir
    config_dir=$(dirname "$config_file")
    mkdir -p "$config_dir"
    printf '{\n  "api_client_id": %s,\n  "api_secret": %s\n}\n' "$(json_escape "$client_id")" "$(json_escape "$secret")" > "$config_file"
    chmod 600 "$config_file"
    log_info "API credentials saved to $config_file"
}

get_server_name() {
    local server_name
    server_name=$(get_resource_name "KAMATERA_SERVER_NAME" "Enter server name: ") || return 1

    if ! validate_server_name "$server_name"; then
        return 1
    fi

    echo "$server_name"
}

# Extract a field from a Kamatera queue response (handles both list and dict responses)
# Usage: _kamatera_queue_field JSON_DATA FIELD_NAME [DEFAULT]
_kamatera_queue_field() {
    local json_data="$1" field="$2" default="${3:-}"
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and len(data) > 0:
    print(data[0].get('$field', '$default'))
elif isinstance(data, dict):
    print(data.get('$field', '$default'))
else:
    print('$default')
" <<< "$json_data" 2>/dev/null
}

# Wait for an async Kamatera command to complete
# Kamatera API returns command IDs for long-running operations
# We poll the queue endpoint until the command completes
# Usage: wait_for_command COMMAND_IDS [TIMEOUT]
wait_for_command() {
    local command_ids="$1"
    local timeout="${2:-$KAMATERA_COMMAND_TIMEOUT}"

    local elapsed=0
    log_warn "Waiting for Kamatera command to complete (timeout: ${timeout}s)..."

    while [[ "$elapsed" -lt "$timeout" ]]; do
        local queue_response
        queue_response=$(kamatera_api GET "/service/queue?id=${command_ids}")

        local status
        status=$(_kamatera_queue_field "$queue_response" "status")

        if [[ "$status" == "complete" ]]; then
            log_info "Command completed successfully"
            printf '%s' "$queue_response"
            return 0
        elif [[ "$status" == "error" ]]; then
            local error_log
            error_log=$(_kamatera_queue_field "$queue_response" "log" "Unknown error")
            log_error "Command failed: $error_log"
            return 1
        fi

        log_warn "Command status: ${status:-pending} (elapsed: ${elapsed}s)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
        elapsed=$((elapsed + INSTANCE_STATUS_POLL_DELAY))
    done

    log_error "Command timed out after ${timeout}s"
    return 1
}

# Generate a random password meeting Kamatera requirements
# (10-20 chars, uppercase, lowercase, digit)
generate_server_password() {
    local password
    if command -v openssl &>/dev/null; then
        password="Sp$(openssl rand -hex 8)1"
    elif [[ -r /dev/urandom ]]; then
        password="Sp$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')1"
    else
        password="Sp$(date +%s)Rn1"
    fi
    printf '%s' "$password"
}

# Parse command IDs from a Kamatera API response
# Kamatera returns an array of command IDs, a single number, or a string
# Usage: parse_command_ids JSON_RESPONSE
parse_command_ids() {
    local response="$1"
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    print(','.join(str(x) for x in data))
elif isinstance(data, (int, float)):
    print(int(data))
else:
    print(data)
" <<< "$response" 2>/dev/null
}

# Extract WAN IP from a Kamatera server info response
# Falls back to any IP if the server is powered on
# Usage: _extract_kamatera_wan_ip JSON_DATA
_extract_kamatera_wan_ip() {
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
server = data[0] if isinstance(data, list) and len(data) > 0 else data
networks = server.get('networks', [])
for net in networks:
    if net.get('network', '').startswith('wan') and net.get('ips'):
        print(net['ips'][0]); sys.exit(0)
if server.get('power') == 'on':
    for net in networks:
        if net.get('ips'):
            print(net['ips'][0]); sys.exit(0)
" <<< "$1" 2>/dev/null
}

# Poll Kamatera server info until a WAN IP address is available
# Sets: KAMATERA_SERVER_IP
# Usage: get_kamatera_server_ip SERVER_NAME [MAX_ATTEMPTS]
get_kamatera_server_ip() {
    local name="$1"
    local max_attempts=${2:-30}
    local attempt=1

    log_warn "Retrieving server IP address..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local info_response
        info_response=$(kamatera_api POST "/service/server/info" "{\"name\":\"$name\"}")

        KAMATERA_SERVER_IP=$(_extract_kamatera_wan_ip "$info_response")

        if [[ -n "$KAMATERA_SERVER_IP" ]]; then
            export KAMATERA_SERVER_IP
            log_info "Server active: IP=$KAMATERA_SERVER_IP"
            return 0
        fi

        log_warn "Waiting for server IP... (attempt $attempt/$max_attempts)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
        attempt=$((attempt + 1))
    done

    log_error "Failed to retrieve server IP address"
    return 1
}

# Validate Kamatera server creation parameters
# Usage: validate_kamatera_params DATACENTER CPU RAM DISK IMAGE BILLING
validate_kamatera_params() {
    local datacenter="$1" cpu="$2" ram="$3" disk="$4" image="$5" billing="$6"
    validate_region_name "$datacenter" || { log_error "Invalid KAMATERA_DATACENTER"; return 1; }
    validate_resource_name "$cpu" || { log_error "Invalid KAMATERA_CPU"; return 1; }
    if [[ ! "$ram" =~ ^[0-9]+$ ]]; then log_error "Invalid KAMATERA_RAM: must be numeric"; return 1; fi
    if [[ ! "$disk" =~ ^[a-zA-Z0-9_=,-]+$ ]]; then log_error "Invalid KAMATERA_DISK"; return 1; fi
    if [[ ! "$image" =~ ^[a-zA-Z0-9_.:-]+$ ]]; then log_error "Invalid KAMATERA_IMAGE"; return 1; fi
    validate_resource_name "$billing" || { log_error "Invalid KAMATERA_BILLING"; return 1; }
}

# Build the JSON request body for Kamatera server creation
# Usage: build_kamatera_server_body NAME PASSWORD DATACENTER IMAGE CPU RAM DISK BILLING SSH_KEY SCRIPT_CONTENT
build_kamatera_server_body() {
    local name="$1" password="$2" datacenter="$3" image="$4"
    local cpu="$5" ram="$6" disk="$7" billing="$8"
    local ssh_key="$9" script_content="${10}"

    local json_ssh_key json_script
    json_ssh_key=$(json_escape "$ssh_key")
    json_script=$(json_escape "$script_content")

    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
body = {
    'name': '$name',
    'password': '$password',
    'passwordValidate': '$password',
    'ssh-key': data['ssh_key'],
    'datacenter': '$datacenter',
    'image': '$image',
    'cpu': '$cpu',
    'ram': $ram,
    'disk': '$disk',
    'dailybackup': 'no',
    'managed': 'no',
    'network': 'name=wan,ip=auto',
    'quantity': 1,
    'billingcycle': '$billing',
    'poweronaftercreate': 'yes',
    'script-file': data['script']
}
print(json.dumps(body))
" <<< "{\"ssh_key\": $json_ssh_key, \"script\": $json_script}"
}

create_server() {
    local name="$1"
    local datacenter="${KAMATERA_DATACENTER:-EU}"
    local cpu="${KAMATERA_CPU:-2B}"
    local ram="${KAMATERA_RAM:-2048}"
    local disk="${KAMATERA_DISK:-size=20}"
    local image="${KAMATERA_IMAGE:-ubuntu_server_24.04_64-bit}"
    local billing="${KAMATERA_BILLING:-hourly}"

    validate_kamatera_params "$datacenter" "$cpu" "$ram" "$disk" "$image" "$billing" || return 1

    log_warn "Creating Kamatera server '$name' (datacenter: $datacenter, cpu: $cpu, ram: ${ram}MB)..."

    # Generate password for the server
    local password
    password=$(generate_server_password)

    # Read SSH public key if available
    local ssh_key=""
    local pub_path="${HOME}/.ssh/id_ed25519.pub"
    if [[ -f "$pub_path" ]]; then
        ssh_key=$(cat "$pub_path")
    fi

    # Build init script
    local script_content
    script_content=$(cat << 'INIT_EOF'
#!/bin/bash
set -e
apt-get update -qq
apt-get install -y -qq curl unzip git zsh
# Install Bun
curl -fsSL https://bun.sh/install | bash
# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
# Configure PATH
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.bashrc
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /root/.zshrc
# Signal completion
touch /root/.cloud-init-complete
INIT_EOF
)

    # Build request body and submit server creation
    local body
    body=$(build_kamatera_server_body "$name" "$password" "$datacenter" "$image" "$cpu" "$ram" "$disk" "$billing" "$ssh_key" "$script_content")

    local response
    response=$(kamatera_api POST "/service/server" "$body")

    local command_ids
    command_ids=$(parse_command_ids "$response")

    if [[ -z "$command_ids" ]]; then
        log_error "Failed to create Kamatera server"
        log_error "API Response: $response"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance"
        log_warn "  - Datacenter unavailable (try different KAMATERA_DATACENTER)"
        log_warn "  - Invalid image name"
        log_warn "Remediation: Check https://console.kamatera.com/"
        return 1
    fi

    log_info "Server creation command submitted: $command_ids"

    local queue_result
    queue_result=$(wait_for_command "$command_ids" 600) || return 1

    KAMATERA_SERVER_NAME_ACTUAL="$name"
    export KAMATERA_SERVER_NAME_ACTUAL

    get_kamatera_server_ip "$name"
}

verify_server_connectivity() {
    local ip="$1"
    local max_attempts=${2:-30}
    # shellcheck disable=SC2154
    generic_ssh_wait "root" "$ip" "$SSH_OPTS -o ConnectTimeout=5" "echo ok" "SSH connectivity" "$max_attempts" 5
}

run_server() {
    local ip="$1"; local cmd="$2"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@$ip" "$cmd"
}

upload_file() {
    local ip="$1"; local local_path="$2"; local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@$ip:$remote_path"
}

interactive_session() {
    local ip="$1"; local cmd="$2"
    ssh -t $SSH_OPTS "root@$ip" "$cmd"
}

destroy_server() {
    local server_name="$1"
    log_warn "Terminating server $server_name..."
    local response
    response=$(kamatera_api POST "/service/server/terminate" "{\"name\":\"$server_name\",\"force\":true}")

    local command_ids
    command_ids=$(parse_command_ids "$response")

    if [[ -n "$command_ids" ]]; then
        wait_for_command "$command_ids" 120 || true
    fi
    log_info "Server $server_name terminated"
}

list_servers() {
    local response
    response=$(kamatera_api POST "/service/server/info" '{}')
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if not isinstance(data, list):
    data = [data] if data else []
if not data:
    print('No servers found')
    sys.exit(0)
print(f\"{'NAME':<25} {'DATACENTER':<15} {'POWER':<10} {'IP':<16} {'CPU':<8} {'RAM':<8}\")
print('-' * 82)
for s in data:
    name = s.get('name', 'N/A')
    dc = s.get('datacenter', 'N/A')
    power = s.get('power', 'N/A')
    ip = 'N/A'
    for net in s.get('networks', []):
        if net.get('network', '').startswith('wan'):
            ips = net.get('ips', [])
            if ips:
                ip = ips[0]
                break
    cpu = s.get('cpu', 'N/A')
    ram = s.get('ram', 'N/A')
    print(f'{name:<25} {dc:<15} {power:<10} {ip:<16} {str(cpu):<8} {str(ram):<8}')
" <<< "$response"
}
