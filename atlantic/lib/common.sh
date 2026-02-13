#!/bin/bash
set -eo pipefail
# Common bash functions for Atlantic.Net Cloud spawn scripts

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
# Atlantic.Net Cloud specific functions
# ============================================================

readonly ATLANTIC_API_BASE="https://cloudapi.atlantic.net"
readonly ATLANTIC_API_VERSION="2010-12-30"

# Generate HMAC-SHA256 signature for Atlantic.Net API
# Args: $1=timestamp $2=guid $3=private_key
atlantic_generate_signature() {
    local timestamp="$1"
    local guid="$2"
    local private_key="$3"
    local string_to_sign="${timestamp}${guid}"

    # Generate HMAC-SHA256, base64 encode, and URL encode
    printf '%s' "$string_to_sign" | \
        openssl dgst -sha256 -hmac "$private_key" -binary | \
        openssl enc -base64 | \
        python3 -c "import sys; from urllib.parse import quote; print(quote(sys.stdin.read().strip()), end='')"
}

# Generate random GUID (UUID v4)
atlantic_generate_guid() {
    if command -v uuidgen &>/dev/null; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    else
        # Fallback to python UUID generation
        python3 -c "import uuid; print(str(uuid.uuid4()))"
    fi
}

# Centralized API call wrapper for Atlantic.Net
# Args: $1=action $2=additional_params (optional, e.g., "instanceid=12345&other=value")
atlantic_api() {
    local action="$1"
    local additional_params="${2:-}"

    check_python_available || return 1

    local timestamp guid signature
    timestamp=$(date +%s)
    guid=$(atlantic_generate_guid)
    signature=$(atlantic_generate_signature "$timestamp" "$guid" "$ATLANTIC_API_PRIVATE_KEY")

    # Build base parameters
    local params="Action=${action}&Format=json&Version=${ATLANTIC_API_VERSION}"
    params="${params}&ACSAccessKeyId=${ATLANTIC_API_ACCESS_KEY}"
    params="${params}&Timestamp=${timestamp}"
    params="${params}&Rndguid=${guid}"
    params="${params}&Signature=${signature}"

    # Add additional parameters if provided
    if [[ -n "$additional_params" ]]; then
        params="${params}&${additional_params}"
    fi

    # Make the API call
    curl -fsSL -X POST "${ATLANTIC_API_BASE}/" -d "$params" 2>/dev/null || {
        log_error "API request failed"
        return 1
    }
}

# Test Atlantic.Net credentials
test_atlantic_credentials() {
    local response
    response=$(atlantic_api "list-locations")

    if echo "$response" | python3 -c "import sys, json; data=json.load(sys.stdin); sys.exit(0 if 'locations' in data else 1)" 2>/dev/null; then
        return 0
    else
        log_error "API Error: Invalid credentials or API error"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify your API keys in the Atlantic.Net Cloud Control Panel"
        log_error "  2. Navigate to: Account → API Info"
        log_error "  3. Ensure both Access Key ID and Private Key are correct"
        return 1
    fi
}

# Ensure Atlantic.Net credentials are available
ensure_atlantic_credentials() {
    local config_file="$HOME/.config/spawn/atlantic.json"

    # Check for access key
    if [[ -z "${ATLANTIC_API_ACCESS_KEY:-}" ]]; then
        if [[ -f "$config_file" ]]; then
            ATLANTIC_API_ACCESS_KEY=$(python3 -c "import json; print(json.load(open('$config_file')).get('access_key', ''))" 2>/dev/null || echo "")
        fi
    fi

    # Check for private key
    if [[ -z "${ATLANTIC_API_PRIVATE_KEY:-}" ]]; then
        if [[ -f "$config_file" ]]; then
            ATLANTIC_API_PRIVATE_KEY=$(python3 -c "import json; print(json.load(open('$config_file')).get('private_key', ''))" 2>/dev/null || echo "")
        fi
    fi

    # Prompt if either is missing
    if [[ -z "${ATLANTIC_API_ACCESS_KEY:-}" ]] || [[ -z "${ATLANTIC_API_PRIVATE_KEY:-}" ]]; then
        log_info "Atlantic.Net API credentials required"
        log_info "Get your credentials at: https://cloudcontrolpanel.com/ → Account → API Info"
        echo ""

        ATLANTIC_API_ACCESS_KEY=$(safe_read "Enter Atlantic.Net Access Key ID: ")
        ATLANTIC_API_PRIVATE_KEY=$(safe_read "Enter Atlantic.Net Private Key: ")

        # Test credentials
        if ! test_atlantic_credentials; then
            log_error "Credential test failed"
            return 1
        fi

        # Save credentials
        mkdir -p "$(dirname "$config_file")"
        python3 -c "import json; json.dump({'access_key': '''$ATLANTIC_API_ACCESS_KEY''', 'private_key': '''$ATLANTIC_API_PRIVATE_KEY'''}, open('$config_file', 'w'), indent=2)"
        chmod 600 "$config_file"
        log_info "Credentials saved to $config_file"
    else
        # Test existing credentials
        if ! test_atlantic_credentials; then
            log_error "Stored credentials are invalid"
            return 1
        fi
    fi

    export ATLANTIC_API_ACCESS_KEY
    export ATLANTIC_API_PRIVATE_KEY
}

# Check if SSH key is registered with Atlantic.Net
# Args: $1=ssh_fingerprint
atlantic_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(atlantic_api "list-sshkeys")

    # Check if the fingerprint exists in the response
    echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
fingerprint = '$fingerprint'.replace(':', '').lower()
for key in data.get('keys_info', []):
    if key.get('key_id', '').replace(':', '').lower() == fingerprint:
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

# Register SSH key with Atlantic.Net
# Args: $1=key_name $2=public_key_path
atlantic_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    # URL-encode the public key
    local encoded_key
    encoded_key=$(python3 -c "import sys; from urllib.parse import quote; print(quote('''$pub_key'''), end='')")

    local response
    response=$(atlantic_api "add-sshkey" "key_name=$(python3 -c "from urllib.parse import quote; print(quote('$key_name'), end='')")&public_key=${encoded_key}")

    if echo "$response" | python3 -c "import sys, json; data=json.load(sys.stdin); sys.exit(0 if 'key_id' in data else 1)" 2>/dev/null; then
        log_info "SSH key registered successfully"
        return 0
    else
        log_error "Failed to register SSH key"
        log_error "Response: $response"
        return 1
    fi
}

# Ensure SSH key exists locally and is registered with Atlantic.Net
ensure_ssh_key() {
    ensure_ssh_key_with_provider atlantic_check_ssh_key atlantic_register_ssh_key "Atlantic.Net"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "ATLANTIC_SERVER_NAME" "Enter server name: "
}

# List available Atlantic.Net images
# Returns: JSON array of images
atlantic_list_images() {
    atlantic_api "list-images"
}

# List available Atlantic.Net plans
# Returns: JSON array of plans
atlantic_list_plans() {
    atlantic_api "list-plans"
}

# List available Atlantic.Net locations
# Returns: JSON array of locations
atlantic_list_locations() {
    atlantic_api "list-locations"
}

# Create Atlantic.Net cloud server
# Args: $1=server_name
create_server() {
    local server_name="$1"

    # Get default configuration from manifest or use hardcoded defaults
    local plan="${ATLANTIC_PLAN:-G2.2GB}"
    local location="${ATLANTIC_LOCATION:-USEAST2}"
    local image="${ATLANTIC_IMAGE:-ubuntu-24.04-x64}"

    log_step "Creating Atlantic.Net server: ${server_name}"
    log_step "  Plan: ${plan}"
    log_step "  Location: ${location}"
    log_step "  Image: ${image}"

    # Get SSH key fingerprint
    local ssh_key_path="$HOME/.ssh/spawn_ed25519.pub"
    local fingerprint
    fingerprint=$(get_ssh_fingerprint "$ssh_key_path")

    # Get the SSH key ID from Atlantic.Net
    local key_id_response key_id
    key_id_response=$(atlantic_api "list-sshkeys")
    key_id=$(echo "$key_id_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
fingerprint = '$fingerprint'.replace(':', '').lower()
for key in data.get('keys_info', []):
    if key.get('key_id', '').replace(':', '').lower() == fingerprint:
        print(key.get('key_id', ''), end='')
        sys.exit(0)
" 2>/dev/null)

    if [[ -z "$key_id" ]]; then
        log_error "SSH key not found in Atlantic.Net account"
        return 1
    fi

    # Generate cloud-init user data
    local userdata
    userdata=$(get_cloud_init_userdata)
    local encoded_userdata
    encoded_userdata=$(python3 -c "import sys; from urllib.parse import quote; print(quote('''$userdata'''), end='')")

    # Encode server name
    local encoded_servername
    encoded_servername=$(python3 -c "from urllib.parse import quote; print(quote('$server_name'), end='')")

    # Create the instance
    log_step "Provisioning server..."
    local create_response
    create_response=$(atlantic_api "run-instance" "servername=${encoded_servername}&imageid=${image}&planname=${plan}&vm_location=${location}&key_id=${key_id}&enablebackup=N")

    # Extract instance ID and IP
    ATLANTIC_INSTANCE_ID=$(echo "$create_response" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('instanceid', ''), end='')" 2>/dev/null)
    ATLANTIC_SERVER_IP=$(echo "$create_response" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('ip_address', ''), end='')" 2>/dev/null)

    if [[ -z "$ATLANTIC_INSTANCE_ID" ]] || [[ -z "$ATLANTIC_SERVER_IP" ]]; then
        log_error "Failed to create server"
        log_error "Response: $create_response"
        return 1
    fi

    export ATLANTIC_INSTANCE_ID
    export ATLANTIC_SERVER_IP

    log_info "Server created successfully"
    log_info "  Instance ID: ${ATLANTIC_INSTANCE_ID}"
    log_info "  IP Address: ${ATLANTIC_SERVER_IP}"
}

# Run command on Atlantic.Net server via SSH
# Args: $1=server_ip $2=command
run_server() {
    local server_ip="$1"
    local command="$2"
    ssh ${SSH_OPTS} "root@${server_ip}" "$command"
}

# Upload file to Atlantic.Net server via SCP
# Args: $1=server_ip $2=local_path $3=remote_path
upload_file() {
    local server_ip="$1"
    local local_path="$2"
    local remote_path="$3"
    scp ${SSH_OPTS} "$local_path" "root@${server_ip}:${remote_path}"
}

# Verify server SSH connectivity
# Args: $1=server_ip
verify_server_connectivity() {
    local server_ip="$1"
    generic_ssh_wait "$server_ip" "root" 300
}

# Start interactive SSH session on Atlantic.Net server
# Args: $1=server_ip $2=command (optional)
interactive_session() {
    local server_ip="$1"
    local command="${2:-bash}"
    ssh -t ${SSH_OPTS} "root@${server_ip}" "$command"
}

# Destroy Atlantic.Net server
# Args: $1=instance_id
destroy_server() {
    local instance_id="$1"
    log_step "Destroying server ${instance_id}..."
    atlantic_api "terminate-instance" "instanceid=${instance_id}"
    log_info "Server destruction initiated"
}
