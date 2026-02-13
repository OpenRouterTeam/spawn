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
        log_error ""
        log_error "How to fix:"
        log_error "  1. Verify credentials at: https://${CLOUDSIGMA_REGION:-zrh}.cloudsigma.com/"
        log_error "  2. Ensure email and password are correct"
        log_error "  3. Check account is active and not suspended"
        return 1
    fi
}

ensure_cloudsigma_credentials() {
    ensure_multi_credentials "CloudSigma" "$HOME/.config/spawn/cloudsigma.json" \
        "https://${CLOUDSIGMA_REGION:-zrh}.cloudsigma.com/" test_cloudsigma_credentials \
        "CLOUDSIGMA_EMAIL:email:Email" \
        "CLOUDSIGMA_PASSWORD:password:Password"
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
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format"
        return 1
    fi
}

ensure_ssh_key() {
    ensure_ssh_key_with_provider cloudsigma_check_ssh_key cloudsigma_register_ssh_key "CloudSigma"
}

get_server_name() {
    get_validated_server_name "CLOUDSIGMA_SERVER_NAME" "Enter server name: "
}

# Find Ubuntu 24.04 image UUID from the CloudSigma library
_find_ubuntu_image_uuid() {
    local response
    response=$(cloudsigma_api GET "/libdrives/?limit=1000")

    _extract_json_field "$response" \
        "next(d['uuid'] for d in d.get('objects',[]) if 'ubuntu' in d.get('name','').lower() and ('24.04' in d.get('name','') or '24-04' in d.get('name','')))"
}

# Clone a library drive and return the new drive UUID
_clone_drive() {
    local image_uuid="$1"
    local name="$2"
    local size_bytes="$3"

    local clone_body
    clone_body=$(python3 -c "
import json, sys
print(json.dumps({'name': sys.argv[1] + '-disk', 'size': int(sys.argv[2]), 'media': 'disk'}))
" "$name" "$size_bytes")

    local response
    response=$(cloudsigma_api POST "/libdrives/${image_uuid}/action/?do=clone" "$clone_body")

    _extract_json_field "$response" \
        "next(obj['uuid'] for obj in d.get('objects',[d]) if 'uuid' in obj)"
}

# Create a CloudSigma drive (disk) for the server
# Sets: CLOUDSIGMA_DRIVE_UUID
create_cloudsigma_drive() {
    local name="$1"
    local size_gb="${CLOUDSIGMA_DISK_SIZE_GB:-20}"
    local size_bytes=$((size_gb * 1024 * 1024 * 1024))

    log_step "Creating drive '${name}-disk' (${size_gb}GB)..."

    local ubuntu_image_uuid
    ubuntu_image_uuid=$(_find_ubuntu_image_uuid)
    if [[ -z "$ubuntu_image_uuid" ]]; then
        log_error "Could not find Ubuntu 24.04 image in CloudSigma library"
        log_error ""
        log_error "How to fix:"
        log_error "  - The image may not be available in region ${CLOUDSIGMA_REGION:-zrh}"
        log_error "  - Try a different CLOUDSIGMA_REGION (e.g., zrh, sjc, wdc)"
        log_error "  - Check available images at: https://cloudsigma.com/"
        return 1
    fi

    log_step "Cloning Ubuntu 24.04 image: $ubuntu_image_uuid"
    CLOUDSIGMA_DRIVE_UUID=$(_clone_drive "$ubuntu_image_uuid" "$name" "$size_bytes")

    if [[ -z "$CLOUDSIGMA_DRIVE_UUID" ]]; then
        log_error "Failed to clone drive"
        log_error ""
        log_error "Common causes:"
        log_error "  - Insufficient account balance or storage quota"
        log_error "  - The source image is temporarily unavailable"
        log_error "  - Try a different CLOUDSIGMA_REGION"
        log_error "Check your account: https://zrh.cloudsigma.com/ui/"
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

# Resolve a CloudSigma IP reference (may be a UUID) to an actual IP address
_resolve_cloudsigma_ip() {
    local ip="$1"
    # If it looks like a UUID, fetch the actual IP from the /ips/ endpoint
    if [[ "$ip" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        _extract_json_field "$(cloudsigma_api GET "/ips/${ip}/")" "d.get('uuid','')"
    else
        echo "$ip"
    fi
}

# Wait for CloudSigma server to become running and get its IP
# Sets: CLOUDSIGMA_SERVER_IP
_wait_for_cloudsigma_server() {
    local server_uuid="$1"

    # IP extraction: get first NIC's IPv4 address (may be a UUID reference)
    local ip_py="next((ic.get('ip',{}).get('uuid','') if isinstance(ic.get('ip'),dict) else ic.get('ip','')) for n in d.get('nics',[]) for ic in [n.get('ip_v4_conf',{})] if ic) if d.get('nics') else ''"

    generic_wait_for_instance cloudsigma_api "/servers/${server_uuid}/" \
        "running" "d.get('status','unknown')" "$ip_py" \
        CLOUDSIGMA_SERVER_IP "Server" 60

    # Resolve UUID-style IP references to actual IP addresses
    if [[ -n "${CLOUDSIGMA_SERVER_IP:-}" ]]; then
        CLOUDSIGMA_SERVER_IP=$(_resolve_cloudsigma_ip "$CLOUDSIGMA_SERVER_IP")
        export CLOUDSIGMA_SERVER_IP
    fi
}

# Look up the UUID of the registered SSH key by fingerprint
_get_ssh_key_uuid() {
    local fingerprint="$1"
    local response
    response=$(cloudsigma_api GET "/keypairs/")

    printf '%s' "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
fp = sys.argv[1].replace(':', '').lower()
for kp in data.get('objects', []):
    if kp.get('fingerprint', '').replace(':', '').lower() == fp:
        print(kp['uuid'])
        break
" "$fingerprint" 2>/dev/null || echo ""
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

    create_cloudsigma_drive "$name"

    local ssh_key_uuid
    ssh_key_uuid=$(_get_ssh_key_uuid "$(get_ssh_fingerprint "$HOME/.ssh/id_ed25519.pub")")

    local server_body
    server_body=$(_cloudsigma_build_server_body "$name" "$cpu_mhz" "$mem_bytes" "$CLOUDSIGMA_DRIVE_UUID" "$ssh_key_uuid")

    log_step "Creating server instance..."
    local create_response
    create_response=$(cloudsigma_api POST "/servers/" "$server_body")

    CLOUDSIGMA_SERVER_UUID=$(_extract_json_field "$create_response" "d.get('uuid','')")

    if [[ -z "$CLOUDSIGMA_SERVER_UUID" ]]; then
        log_error "Failed to create CloudSigma server"
        log_error "API Error: $(extract_api_error_message "$create_response" "$create_response")"
        log_error ""
        log_error "Common issues:"
        log_error "  - Insufficient account balance"
        log_error "  - Resource quota exceeded (CPU, memory, or drives)"
        log_error "  - Region capacity limits reached"
        log_error ""
        return 1
    fi

    log_info "Server created: $CLOUDSIGMA_SERVER_UUID"

    log_step "Starting server..."
    cloudsigma_api POST "/servers/${CLOUDSIGMA_SERVER_UUID}/action/?do=start" "{}"

    _wait_for_cloudsigma_server "$CLOUDSIGMA_SERVER_UUID"
}

# SSH operations — CloudSigma uses 'cloudsigma' user for SSH keys
SSH_USER="cloudsigma"
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }
