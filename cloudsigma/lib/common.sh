#!/bin/bash
# Common bash functions for CloudSigma spawn scripts

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
# CloudSigma specific functions
# ============================================================

# CloudSigma API endpoints by region
# Default to Zurich (zrh), can be overridden with CLOUDSIGMA_REGION env var
readonly CLOUDSIGMA_REGION_DEFAULT="zrh"
readonly CLOUDSIGMA_API_VERSION="2.0"

# Get API base URL for the selected region
get_cloudsigma_api_base() {
    local region="${CLOUDSIGMA_REGION:-$CLOUDSIGMA_REGION_DEFAULT}"
    echo "https://${region}.cloudsigma.com/api/${CLOUDSIGMA_API_VERSION}"
}

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# CloudSigma API call using HTTP Basic Auth
cloudsigma_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"

    local api_base
    api_base=$(get_cloudsigma_api_base)

    # CloudSigma uses HTTP Basic Auth with email:password
    # The credentials are passed as CLOUDSIGMA_EMAIL and CLOUDSIGMA_PASSWORD
    local auth_header="Authorization: Basic $(printf '%s:%s' "${CLOUDSIGMA_EMAIL}" "${CLOUDSIGMA_PASSWORD}" | base64)"

    if [[ -n "$body" ]]; then
        curl -sS -X "$method" \
            "${api_base}${endpoint}" \
            -H "$auth_header" \
            -H "Content-Type: application/json" \
            -d "$body"
    else
        curl -sS -X "$method" \
            "${api_base}${endpoint}" \
            -H "$auth_header"
    fi
}

test_cloudsigma_credentials() {
    local response
    response=$(cloudsigma_api GET "/balance/")
    if echo "$response" | grep -q '"balance"'; then
        log_info "CloudSigma credentials validated"
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$response" "Unable to authenticate")"
        log_warn "Remediation steps:"
        log_warn "  1. Verify credentials at: https://${CLOUDSIGMA_REGION:-zrh}.cloudsigma.com/"
        log_warn "  2. Ensure email and password are correct"
        log_warn "  3. Check account is active and not suspended"
        return 1
    fi
}

ensure_cloudsigma_credentials() {
    # CloudSigma uses email + password for API auth
    if [[ -z "${CLOUDSIGMA_EMAIL:-}" ]]; then
        if [[ -f "$HOME/.config/spawn/cloudsigma.json" ]]; then
            CLOUDSIGMA_EMAIL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('email', ''))" "$HOME/.config/spawn/cloudsigma.json" 2>/dev/null || echo "")
            CLOUDSIGMA_PASSWORD=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('password', ''))" "$HOME/.config/spawn/cloudsigma.json" 2>/dev/null || echo "")
        fi
    fi

    if [[ -z "${CLOUDSIGMA_EMAIL:-}" ]] || [[ -z "${CLOUDSIGMA_PASSWORD:-}" ]]; then
        log_warn "CloudSigma credentials not found in environment or config file"
        echo ""
        log_info "Get your credentials at: https://${CLOUDSIGMA_REGION:-zrh}.cloudsigma.com/"
        echo ""
        printf "Enter your CloudSigma email: "
        CLOUDSIGMA_EMAIL=$(safe_read "")
        printf "Enter your CloudSigma password: "
        CLOUDSIGMA_PASSWORD=$(safe_read "")

        # Save credentials
        mkdir -p "$HOME/.config/spawn"
        python3 -c "
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({'email': sys.argv[2], 'password': sys.argv[3]}, f)
" "$HOME/.config/spawn/cloudsigma.json" "$CLOUDSIGMA_EMAIL" "$CLOUDSIGMA_PASSWORD"
        chmod 600 "$HOME/.config/spawn/cloudsigma.json"
    fi

    test_cloudsigma_credentials
}

# Check if SSH key is registered with CloudSigma
cloudsigma_check_ssh_key() {
    local fingerprint="$1"
    local response
    response=$(cloudsigma_api GET "/keypairs/")

    # CloudSigma stores SSH keys in keypairs with a fingerprint field
    if echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
fingerprint = sys.argv[1].replace(':', '').lower()
for kp in data.get('objects', []):
    kp_fp = kp.get('fingerprint', '').replace(':', '').lower()
    if kp_fp == fingerprint:
        sys.exit(0)
sys.exit(1)
" "$fingerprint" 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Register SSH key with CloudSigma
cloudsigma_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    # CloudSigma accepts the public key directly
    local body
    body=$(python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1],
    'public_key': sys.argv[2]
}))
" "$key_name" "$pub_key")

    local response
    response=$(cloudsigma_api POST "/keypairs/" "$body")

    if echo "$response" | grep -q '"uuid"'; then
        return 0
    else
        log_error "API Error: $(extract_api_error_message "$response" "$response")"
        log_warn "Common causes:"
        log_warn "  - SSH key already registered with this name"
        log_warn "  - Invalid SSH key format"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider cloudsigma_check_ssh_key cloudsigma_register_ssh_key "CloudSigma"
}

get_server_name() {
    get_validated_server_name "CLOUDSIGMA_SERVER_NAME" "Enter server name: "
}

# Create a CloudSigma drive (disk) for the server
# Returns the drive UUID in CLOUDSIGMA_DRIVE_UUID
create_cloudsigma_drive() {
    local name="$1"
    local size_gb="${CLOUDSIGMA_DISK_SIZE_GB:-20}"
    local size_bytes=$((size_gb * 1024 * 1024 * 1024))

    log_step "Creating drive '${name}-disk' (${size_gb}GB)..."

    # Clone from Ubuntu 24.04 image
    # First, find the Ubuntu 24.04 image UUID
    local image_response
    image_response=$(cloudsigma_api GET "/libdrives/?limit=1000")

    local ubuntu_image_uuid
    ubuntu_image_uuid=$(echo "$image_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for drive in data.get('objects', []):
    name = drive.get('name', '').lower()
    if 'ubuntu' in name and ('24.04' in name or '24-04' in name):
        print(drive['uuid'])
        break
" 2>/dev/null || echo "")

    if [[ -z "$ubuntu_image_uuid" ]]; then
        log_error "Could not find Ubuntu 24.04 image in CloudSigma library"
        return 1
    fi

    log_step "Cloning Ubuntu 24.04 image: $ubuntu_image_uuid"

    # Clone the image to create a new drive
    local clone_body
    clone_body=$(python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1] + '-disk',
    'size': int(sys.argv[2]),
    'media': 'disk'
}))
" "$name" "$size_bytes")

    local clone_response
    clone_response=$(cloudsigma_api POST "/libdrives/${ubuntu_image_uuid}/action/?do=clone" "$clone_body")

    CLOUDSIGMA_DRIVE_UUID=$(echo "$clone_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for obj in data.get('objects', [data]):
    if 'uuid' in obj:
        print(obj['uuid'])
        break
" 2>/dev/null || echo "")

    if [[ -z "$CLOUDSIGMA_DRIVE_UUID" ]]; then
        log_error "Failed to create drive: $clone_response"
        return 1
    fi

    log_info "Drive created: $CLOUDSIGMA_DRIVE_UUID"
}

# Build JSON request body for CloudSigma server creation
_cloudsigma_build_server_body() {
    local name="$1"
    local cpu_mhz="$2"
    local mem_bytes="$3"
    local drive_uuid="$4"
    local ssh_key_uuid="$5"

    python3 -c "
import json, sys
name, cpu_mhz, mem_bytes, drive_uuid, ssh_key_uuid, vnc_pass = sys.argv[1:7]

body = {
    'name': name,
    'cpu': int(cpu_mhz),
    'mem': int(mem_bytes),
    'smp': 1,
    'cpu_type': 'amd',
    'hypervisor': 'kvm',
    'vnc_password': vnc_pass,
    'drives': [
        {
            'boot_order': 1,
            'dev_channel': '0:0',
            'device': 'virtio',
            'drive': drive_uuid
        }
    ],
    'nics': [
        {
            'ip_v4_conf': {
                'conf': 'dhcp',
                'ip': None
            },
            'model': 'virtio'
        }
    ]
}

if ssh_key_uuid:
    body['pubkeys'] = [{'uuid': ssh_key_uuid}]

print(json.dumps(body))
" "$name" "$cpu_mhz" "$mem_bytes" "$drive_uuid" "$ssh_key_uuid" "$(openssl rand -hex 8)"
}

# Wait for CloudSigma server to become running and get its IP
# Sets: CLOUDSIGMA_SERVER_IP
_wait_for_cloudsigma_server() {
    local server_uuid="$1"
    local max_attempts=${2:-60}

    log_step "Waiting for server to get IP address..."

    local attempt=0
    while [[ $attempt -lt $max_attempts ]]; do
        attempt=$((attempt + 1))

        local response
        response=$(cloudsigma_api GET "/servers/${server_uuid}/")

        local status
        status=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('status', 'unknown'))
" 2>/dev/null || echo "unknown")

        local ip
        ip=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for nic in data.get('nics', []):
    ip_conf = nic.get('ip_v4_conf', {})
    ip = ip_conf.get('ip', {})
    if isinstance(ip, dict):
        uuid = ip.get('uuid', '')
        if uuid:
            print(uuid)
            break
    elif ip:
        print(ip)
        break
" 2>/dev/null || echo "")

        if [[ "$status" == "running" && -n "$ip" ]]; then
            # If IP is a UUID, we need to fetch the actual IP address
            if [[ "$ip" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
                local ip_response
                ip_response=$(cloudsigma_api GET "/ips/${ip}/")
                ip=$(echo "$ip_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
# CloudSigma IP resources use 'uuid' as the IP address string
addr = data.get('uuid', '')
print(addr)
" 2>/dev/null || echo "")
            fi

            CLOUDSIGMA_SERVER_IP="$ip"
            log_info "Server is running with IP: $ip"
            return 0
        fi

        log_step "Server status: $status (attempt $attempt/$max_attempts)"
        sleep "$INSTANCE_STATUS_POLL_DELAY"
    done

    log_error "Server did not become ready within expected time"
    return 1
}

create_server() {
    local name="$1"
    local cpu_mhz="${CLOUDSIGMA_CPU_MHZ:-1000}"  # 1 GHz
    local mem_gb="${CLOUDSIGMA_MEMORY_GB:-2}"
    local mem_bytes=$((mem_gb * 1024 * 1024 * 1024))

    # Validate region before using it in API URLs
    local region="${CLOUDSIGMA_REGION:-$CLOUDSIGMA_REGION_DEFAULT}"
    validate_region_name "$region" || { log_error "Invalid CLOUDSIGMA_REGION"; return 1; }

    log_step "Creating CloudSigma server '$name'..."
    log_step "  CPU: ${cpu_mhz} MHz, Memory: ${mem_gb}GB"

    # Create drive first
    create_cloudsigma_drive "$name"

    # Get SSH key UUID
    local ssh_key_uuid=""
    local keypairs_response
    keypairs_response=$(cloudsigma_api GET "/keypairs/")

    local fingerprint
    fingerprint=$(get_ssh_fingerprint "$HOME/.ssh/id_ed25519.pub")

    ssh_key_uuid=$(echo "$keypairs_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
fingerprint = sys.argv[1].replace(':', '').lower()
for kp in data.get('objects', []):
    kp_fp = kp.get('fingerprint', '').replace(':', '').lower()
    if kp_fp == fingerprint:
        print(kp['uuid'])
        break
" "$fingerprint" 2>/dev/null || echo "")

    # Build server creation request
    local server_body
    server_body=$(_cloudsigma_build_server_body "$name" "$cpu_mhz" "$mem_bytes" "$CLOUDSIGMA_DRIVE_UUID" "$ssh_key_uuid")

    log_step "Creating server instance..."
    local create_response
    create_response=$(cloudsigma_api POST "/servers/" "$server_body")

    CLOUDSIGMA_SERVER_UUID=$(echo "$create_response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('uuid', ''))
" 2>/dev/null || echo "")

    if [[ -z "$CLOUDSIGMA_SERVER_UUID" ]]; then
        log_error "Failed to create server: $create_response"
        return 1
    fi

    log_info "Server created: $CLOUDSIGMA_SERVER_UUID"

    # Start the server
    log_step "Starting server..."
    cloudsigma_api POST "/servers/${CLOUDSIGMA_SERVER_UUID}/action/?do=start" "{}"

    _wait_for_cloudsigma_server "$CLOUDSIGMA_SERVER_UUID"
}

# Upload file to CloudSigma server via SCP
upload_file() {
    local server_ip="$1"
    local local_path="$2"
    local remote_path="${3:-$(basename "$local_path")}"

    # CloudSigma uses cloudsigma user by default for SSH keys
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        "$local_path" "cloudsigma@${server_ip}:${remote_path}"
}

# Run command on CloudSigma server via SSH
run_server() {
    local server_ip="$1"
    shift
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        "cloudsigma@${server_ip}" "$@"
}

# Start interactive SSH session on CloudSigma server
interactive_session() {
    local server_ip="$1"
    local command="${2:-bash}"

    log_step "Connecting to CloudSigma server..."
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -t "cloudsigma@${server_ip}" "$command"
}

# Verify SSH connectivity to the server
verify_server_connectivity() {
    local server_ip="$1"
    generic_ssh_wait "cloudsigma@${server_ip}" 60
}

# Wait for cloud-init to complete on the server
wait_for_cloud_init() {
    local server_ip="$1"
    local max_wait="${2:-300}"

    log_step "Waiting for cloud-init to complete..."

    local elapsed=0
    while [[ $elapsed -lt $max_wait ]]; do
        if run_server "$server_ip" "cloud-init status --wait" 2>/dev/null; then
            log_info "Cloud-init completed"
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done

    log_warn "Cloud-init did not complete within ${max_wait}s, continuing anyway"
    return 0
}
