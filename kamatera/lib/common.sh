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
kamatera_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    local max_retries="${4:-3}"

    local attempt=1
    local interval=2
    local max_interval=30

    while [[ "$attempt" -le "$max_retries" ]]; do
        local args=(
            -s
            -w "\n%{http_code}"
            -X "$method"
            -H "AuthClientId: ${KAMATERA_API_CLIENT_ID}"
            -H "AuthSecret: ${KAMATERA_API_SECRET}"
            -H "Content-Type: application/json"
        )

        if [[ -n "$body" ]]; then
            args+=(-d "$body")
        fi

        local response
        response=$(curl "${args[@]}" "${KAMATERA_API_BASE}${endpoint}" 2>&1)
        local curl_exit_code=$?

        local http_code
        http_code=$(printf '%s' "$response" | tail -1)
        local response_body
        response_body=$(printf '%s' "$response" | head -n -1)

        # Success case
        if [[ "$curl_exit_code" -eq 0 ]] && [[ "$http_code" != "429" ]] && [[ "$http_code" != "503" ]]; then
            printf '%s' "$response_body"
            return 0
        fi

        # Decide whether to retry
        local should_retry=false
        if [[ "$curl_exit_code" -ne 0 ]]; then
            _api_should_retry_on_error "$attempt" "$max_retries" "$interval" "$max_interval" "Kamatera API network error" && should_retry=true
            if [[ "$should_retry" != "true" ]]; then
                log_error "Kamatera API network error after $max_retries attempts"
                return 1
            fi
        else
            _api_handle_transient_http_error "$http_code" "$attempt" "$max_retries" "$interval" "$max_interval" && should_retry=true
            if [[ "$should_retry" != "true" ]]; then
                printf '%s' "$response_body"
                return 1
            fi
        fi

        # Backoff
        interval=$((interval * 2))
        if [[ "$interval" -gt "$max_interval" ]]; then
            interval="$max_interval"
        fi
        attempt=$((attempt + 1))
    done

    log_error "Kamatera API retry logic exhausted"
    return 1
}

ensure_kamatera_token() {
    check_python_available || return 1

    if [[ -n "${KAMATERA_API_CLIENT_ID:-}" ]] && [[ -n "${KAMATERA_API_SECRET:-}" ]]; then
        log_info "Using Kamatera API credentials from environment"
        return 0
    fi

    local config_dir="$HOME/.config/spawn"
    local config_file="$config_dir/kamatera.json"

    if [[ -f "$config_file" ]]; then
        local creds
        creds=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get('api_client_id', ''))
print(d.get('api_secret', ''))
" "$config_file" 2>/dev/null) || true
        if [[ -n "${creds}" ]]; then
            local saved_client_id saved_secret
            { read -r saved_client_id; read -r saved_secret; } <<< "${creds}"
            if [[ -n "$saved_client_id" ]] && [[ -n "$saved_secret" ]]; then
                export KAMATERA_API_CLIENT_ID="$saved_client_id"
                export KAMATERA_API_SECRET="$saved_secret"
                log_info "Using Kamatera API credentials from $config_file"
                return 0
            fi
        fi
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

    # Validate credentials by listing server options (lightweight call)
    local response
    response=$(kamatera_api POST "/service/server/info" '{"name":"__test__"}')
    # A valid response (even if no server found) means auth succeeded
    # An auth error returns a specific error message
    if printf '%s' "$response" | grep -qi "authentication failed\|unauthorized\|invalid.*auth"; then
        log_error "Authentication failed: Invalid Kamatera API credentials"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://console.kamatera.com/keys"
        log_warn "  2. Ensure the API key has appropriate permissions"
        unset KAMATERA_API_CLIENT_ID
        unset KAMATERA_API_SECRET
        return 1
    fi

    log_info "API credentials validated"

    mkdir -p "$config_dir"
    printf '{\n  "api_client_id": "%s",\n  "api_secret": "%s"\n}\n' "$(json_escape "$client_id")" "$(json_escape "$secret")" > "$config_file"
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
        status=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and len(data) > 0:
    print(data[0].get('status', ''))
elif isinstance(data, dict):
    print(data.get('status', ''))
else:
    print('')
" <<< "$queue_response" 2>/dev/null)

        if [[ "$status" == "complete" ]]; then
            log_info "Command completed successfully"
            printf '%s' "$queue_response"
            return 0
        elif [[ "$status" == "error" ]]; then
            local error_log
            error_log=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and len(data) > 0:
    print(data[0].get('log', 'Unknown error'))
elif isinstance(data, dict):
    print(data.get('log', 'Unknown error'))
" <<< "$queue_response" 2>/dev/null)
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

create_server() {
    local name="$1"
    local datacenter="${KAMATERA_DATACENTER:-EU}"
    local cpu="${KAMATERA_CPU:-2B}"
    local ram="${KAMATERA_RAM:-2048}"
    local disk="${KAMATERA_DISK:-size=20}"
    local image="${KAMATERA_IMAGE:-ubuntu_server_24.04_64-bit}"
    local billing="${KAMATERA_BILLING:-hourly}"

    # Validate env var inputs to prevent injection into Python code
    validate_region_name "$datacenter" || { log_error "Invalid KAMATERA_DATACENTER"; return 1; }
    validate_resource_name "$cpu" || { log_error "Invalid KAMATERA_CPU"; return 1; }
    if [[ ! "$ram" =~ ^[0-9]+$ ]]; then log_error "Invalid KAMATERA_RAM: must be numeric"; return 1; fi
    if [[ ! "$disk" =~ ^[a-zA-Z0-9_=,-]+$ ]]; then log_error "Invalid KAMATERA_DISK"; return 1; fi
    if [[ ! "$image" =~ ^[a-zA-Z0-9_.:-]+$ ]]; then log_error "Invalid KAMATERA_IMAGE"; return 1; fi
    validate_resource_name "$billing" || { log_error "Invalid KAMATERA_BILLING"; return 1; }

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

    # Pass SSH key and script content safely via stdin as JSON
    local json_ssh_key
    json_ssh_key=$(json_escape "$ssh_key")
    local json_script
    json_script=$(json_escape "$script_content")

    local body
    body=$(python3 -c "
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
" <<< "{\"ssh_key\": $json_ssh_key, \"script\": $json_script}")

    local response
    response=$(kamatera_api POST "/service/server" "$body")

    # Parse command ID from response (Kamatera returns array of command IDs)
    local command_ids
    command_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    print(','.join(str(x) for x in data))
elif isinstance(data, (int, float)):
    print(int(data))
else:
    print(data)
" <<< "$response" 2>/dev/null)

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

    # Wait for the command to complete
    local queue_result
    queue_result=$(wait_for_command "$command_ids" 600) || return 1

    # Extract server name from the completed command
    KAMATERA_SERVER_NAME_ACTUAL="$name"
    export KAMATERA_SERVER_NAME_ACTUAL

    # Get server info to retrieve IP address
    log_warn "Retrieving server IP address..."
    local max_info_attempts=30
    local info_attempt=1
    while [[ "$info_attempt" -le "$max_info_attempts" ]]; do
        local info_response
        info_response=$(kamatera_api POST "/service/server/info" "{\"name\":\"$name\"}")

        KAMATERA_SERVER_IP=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list) and len(data) > 0:
    server = data[0]
else:
    server = data
networks = server.get('networks', [])
for net in networks:
    net_name = net.get('network', '')
    if net_name.startswith('wan'):
        ips = net.get('ips', [])
        if ips:
            print(ips[0])
            sys.exit(0)
# Fallback: try power_on field or any IP
power = server.get('power', '')
if power == 'on':
    for net in networks:
        ips = net.get('ips', [])
        if ips:
            print(ips[0])
            sys.exit(0)
" <<< "$info_response" 2>/dev/null)

        if [[ -n "$KAMATERA_SERVER_IP" ]]; then
            export KAMATERA_SERVER_IP
            log_info "Server active: IP=$KAMATERA_SERVER_IP"
            return 0
        fi

        log_warn "Waiting for server IP... (attempt $info_attempt/$max_info_attempts)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
        info_attempt=$((info_attempt + 1))
    done

    log_error "Failed to retrieve server IP address"
    return 1
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

    # Parse command ID and wait for completion
    local command_ids
    command_ids=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
if isinstance(data, list):
    print(','.join(str(x) for x in data))
elif isinstance(data, (int, float)):
    print(int(data))
else:
    print(data)
" <<< "$response" 2>/dev/null)

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
