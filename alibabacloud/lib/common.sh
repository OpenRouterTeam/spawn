#!/bin/bash
# Common bash functions for Alibaba Cloud spawn scripts

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
# Alibaba Cloud specific functions
# ============================================================

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# Install Alibaba Cloud CLI if not present
ensure_aliyun_cli() {
    if command -v aliyun &> /dev/null; then
        log_info "Alibaba Cloud CLI is already installed"
        return 0
    fi

    log_step "Installing Alibaba Cloud CLI..."
    if ! bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/install.sh)"; then
        log_error "Failed to install Alibaba Cloud CLI"
        log_error "How to fix:"
        log_error "  1. Install manually from: https://www.alibabacloud.com/help/en/cli"
        log_error "  2. Ensure curl and bash are available"
        return 1
    fi

    # Verify installation
    if ! command -v aliyun &> /dev/null; then
        log_error "Alibaba Cloud CLI installation completed but 'aliyun' command not found"
        log_error "You may need to restart your shell or add it to PATH"
        return 1
    fi

    log_info "Alibaba Cloud CLI installed successfully"
}

# Test Alibaba Cloud credentials by listing regions
test_aliyun_credentials() {
    local response
    response=$(aliyun ecs DescribeRegions --output json 2>&1 || echo "")

    if echo "$response" | grep -q '"Regions"'; then
        log_info "Credentials validated"
        return 0
    else
        log_error "Credential validation failed"
        log_error "API Error: $response"
        log_error ""
        log_error "How to fix:"
        log_error "  1. Get your Access Key ID and Secret from:"
        log_error "     https://ram.console.aliyun.com/manage/ak"
        log_error "  2. Ensure the AccessKey has ECS permissions"
        log_error "  3. Check the region is correct (default: cn-hangzhou)"
        return 1
    fi
}

# Ensure Alibaba Cloud credentials are configured
ensure_aliyun_credentials() {
    ensure_aliyun_cli

    # Check if already configured
    if aliyun configure list 2>/dev/null | grep -q "Profile"; then
        if test_aliyun_credentials; then
            return 0
        fi
        log_warn "Existing credentials invalid, need to reconfigure"
    fi

    # Get credentials from env vars or config file or prompt
    local config_file="$HOME/.config/spawn/alibabacloud.json"
    local ak_id="${ALIYUN_ACCESS_KEY_ID:-}"
    local ak_secret="${ALIYUN_ACCESS_KEY_SECRET:-}"
    local region="${ALIYUN_REGION:-cn-hangzhou}"

    # Try loading from config file
    if [[ -z "$ak_id" ]] && [[ -f "$config_file" ]]; then
        log_step "Loading credentials from $config_file"
        local creds
        creds=$(_load_json_config_fields "$config_file" "access_key_id" "access_key_secret" "region" 2>/dev/null || echo "")
        if [[ -n "$creds" ]]; then
            IFS=$'\t' read -r ak_id ak_secret region <<< "$creds"
        fi
    fi

    # Prompt for missing credentials
    if [[ -z "$ak_id" ]] || [[ -z "$ak_secret" ]]; then
        log_info "Alibaba Cloud credentials not found"
        log_info "Get your Access Key from: https://ram.console.aliyun.com/manage/ak"
        echo ""

        if [[ -z "$ak_id" ]]; then
            printf "Enter Access Key ID: "
            ak_id=$(safe_read)
        fi

        if [[ -z "$ak_secret" ]]; then
            printf "Enter Access Key Secret: "
            ak_secret=$(safe_read)
        fi

        # Save to config file
        mkdir -p "$(dirname "$config_file")"
        _save_json_config "$config_file" \
            "access_key_id" "$ak_id" \
            "access_key_secret" "$ak_secret" \
            "region" "$region"
        log_info "Credentials saved to $config_file"
    fi

    # Configure aliyun CLI
    log_step "Configuring Alibaba Cloud CLI..."
    aliyun configure set \
        --mode AK \
        --access-key-id "$ak_id" \
        --access-key-secret "$ak_secret" \
        --region "$region" \
        --language en

    # Verify
    if test_aliyun_credentials; then
        return 0
    else
        log_error "Credential configuration failed"
        return 1
    fi
}

# Check if SSH key pair exists in Alibaba Cloud
aliyun_check_ssh_key() {
    local key_name="$1"
    local response
    response=$(aliyun ecs DescribeKeyPairs --KeyPairName "$key_name" --output json 2>/dev/null || echo "{}")

    if echo "$response" | grep -q '"KeyPairName"'; then
        return 0
    else
        return 1
    fi
}

# Register SSH key with Alibaba Cloud
aliyun_register_ssh_key() {
    local key_name="$1"
    local pub_path="$2"
    local pub_key
    pub_key=$(cat "$pub_path")

    local response
    response=$(aliyun ecs ImportKeyPair \
        --KeyPairName "$key_name" \
        --PublicKeyBody "$pub_key" \
        --output json 2>&1 || echo "")

    if echo "$response" | grep -q '"KeyPairName"'; then
        log_info "SSH key registered successfully"
        return 0
    else
        log_error "Failed to register SSH key"
        log_error "API Error: $response"
        log_error ""
        log_error "Common causes:"
        log_error "  - SSH key already registered with this name"
        log_error "  - Invalid SSH key format (must be valid RSA or ed25519 public key)"
        log_error "  - Access Key lacks ECS write permissions"
        return 1
    fi
}

# Ensure SSH key exists locally and is registered with Alibaba Cloud
ensure_ssh_key() {
    ensure_ssh_key_with_provider aliyun_check_ssh_key aliyun_register_ssh_key "Alibaba Cloud"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "ALIYUN_INSTANCE_NAME" "Enter instance name: "
}

# Wait for Alibaba Cloud ECS instance to become running
# Sets: ALIYUN_INSTANCE_IP
# Usage: _wait_for_aliyun_instance INSTANCE_ID [MAX_ATTEMPTS]
_wait_for_aliyun_instance() {
    local instance_id="$1"
    local max_attempts="${2:-60}"
    local attempt=0

    log_step "Waiting for instance to start (max ${max_attempts} attempts)..."

    while [[ $attempt -lt $max_attempts ]]; do
        local response
        response=$(aliyun ecs DescribeInstances \
            --InstanceIds "[\"$instance_id\"]" \
            --output json 2>/dev/null || echo "{}")

        local status ip_address
        status=$(echo "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    instances = data.get('Instances', {}).get('Instance', [])
    if instances:
        print(instances[0].get('Status', ''))
except:
    pass
" 2>/dev/null || echo "")

        ip_address=$(echo "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    instances = data.get('Instances', {}).get('Instance', [])
    if instances:
        ips = instances[0].get('PublicIpAddress', {}).get('IpAddress', [])
        if ips:
            print(ips[0])
except:
    pass
" 2>/dev/null || echo "")

        if [[ "$status" == "Running" ]] && [[ -n "$ip_address" ]]; then
            ALIYUN_INSTANCE_IP="$ip_address"
            export ALIYUN_INSTANCE_IP
            log_info "Instance is running (IP: ${ALIYUN_INSTANCE_IP})"
            return 0
        fi

        attempt=$((attempt + 1))
        if [[ $attempt -lt $max_attempts ]]; then
            log_step "Instance status: $status (attempt $attempt/$max_attempts)"
            sleep "$INSTANCE_STATUS_POLL_DELAY"
        fi
    done

    log_error "Instance did not become ready within expected time"
    log_error "Check instance status: aliyun ecs DescribeInstances --InstanceIds '[\"$instance_id\"]'"
    return 1
}

# Create security group if it doesn't exist
# Usage: _ensure_security_group
_ensure_security_group() {
    local vpc_id="$1"
    local sg_name="${ALIYUN_SECURITY_GROUP_NAME:-spawn-default}"

    # Check if security group already exists
    local response
    response=$(aliyun ecs DescribeSecurityGroups \
        --VpcId "$vpc_id" \
        --SecurityGroupName "$sg_name" \
        --output json 2>/dev/null || echo "{}")

    local sg_id
    sg_id=$(echo "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    groups = data.get('SecurityGroups', {}).get('SecurityGroup', [])
    if groups:
        print(groups[0].get('SecurityGroupId', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [[ -n "$sg_id" ]]; then
        echo "$sg_id"
        return 0
    fi

    # Create new security group
    log_step "Creating security group '$sg_name'..."
    response=$(aliyun ecs CreateSecurityGroup \
        --VpcId "$vpc_id" \
        --SecurityGroupName "$sg_name" \
        --Description "Created by spawn for AI agent instances" \
        --output json 2>&1 || echo "")

    sg_id=$(echo "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('SecurityGroupId', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [[ -z "$sg_id" ]]; then
        log_error "Failed to create security group: $response"
        return 1
    fi

    # Add SSH rule
    log_step "Adding SSH rule to security group..."
    aliyun ecs AuthorizeSecurityGroup \
        --SecurityGroupId "$sg_id" \
        --IpProtocol tcp \
        --PortRange "22/22" \
        --SourceCidrIp "0.0.0.0/0" \
        --output json >/dev/null 2>&1

    echo "$sg_id"
}

# Create Alibaba Cloud ECS instance
# Sets: ALIYUN_INSTANCE_ID, ALIYUN_INSTANCE_IP
create_server() {
    local name="$1"
    local region="${ALIYUN_REGION:-cn-hangzhou}"
    local instance_type="${ALIYUN_INSTANCE_TYPE:-ecs.t5-lc1m2.small}"
    local image_id="${ALIYUN_IMAGE_ID:-ubuntu_24_04_x64_20G_alibase_20240812.vhd}"

    # Validate inputs to prevent injection
    validate_resource_name "$instance_type" || { log_error "Invalid ALIYUN_INSTANCE_TYPE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid ALIYUN_REGION"; return 1; }

    # Get or create VPC
    log_step "Checking for VPC in region $region..."
    local vpc_response
    vpc_response=$(aliyun ecs DescribeVpcs --output json 2>/dev/null || echo "{}")
    local vpc_id
    vpc_id=$(echo "$vpc_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    vpcs = data.get('Vpcs', {}).get('Vpc', [])
    if vpcs:
        print(vpcs[0].get('VpcId', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [[ -z "$vpc_id" ]]; then
        log_step "Creating VPC..."
        local create_vpc_response
        create_vpc_response=$(aliyun ecs CreateVpc \
            --CidrBlock "172.16.0.0/12" \
            --VpcName "spawn-vpc" \
            --output json 2>&1 || echo "")
        vpc_id=$(echo "$create_vpc_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('VpcId', ''))
except:
    pass
" 2>/dev/null || echo "")

        if [[ -z "$vpc_id" ]]; then
            log_error "Failed to create VPC: $create_vpc_response"
            return 1
        fi
        sleep 3  # Wait for VPC to be ready
    fi
    log_info "Using VPC: $vpc_id"

    # Get or create vSwitch
    log_step "Checking for vSwitch..."
    local vswitch_response
    vswitch_response=$(aliyun ecs DescribeVSwitches --VpcId "$vpc_id" --output json 2>/dev/null || echo "{}")
    local vswitch_id
    vswitch_id=$(echo "$vswitch_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    vswitches = data.get('VSwitches', {}).get('VSwitch', [])
    if vswitches:
        print(vswitches[0].get('VSwitchId', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [[ -z "$vswitch_id" ]]; then
        # Get first availability zone
        local zone_id
        zone_id=$(aliyun ecs DescribeZones --output json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    zones = data.get('Zones', {}).get('Zone', [])
    if zones:
        print(zones[0].get('ZoneId', ''))
except:
    pass
" 2>/dev/null || echo "")

        if [[ -z "$zone_id" ]]; then
            log_error "Failed to get availability zone"
            return 1
        fi

        log_step "Creating vSwitch in zone $zone_id..."
        local create_vs_response
        create_vs_response=$(aliyun ecs CreateVSwitch \
            --VpcId "$vpc_id" \
            --ZoneId "$zone_id" \
            --CidrBlock "172.16.0.0/24" \
            --VSwitchName "spawn-vswitch" \
            --output json 2>&1 || echo "")
        vswitch_id=$(echo "$create_vs_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('VSwitchId', ''))
except:
    pass
" 2>/dev/null || echo "")

        if [[ -z "$vswitch_id" ]]; then
            log_error "Failed to create vSwitch: $create_vs_response"
            return 1
        fi
        sleep 3  # Wait for vSwitch to be ready
    fi
    log_info "Using vSwitch: $vswitch_id"

    # Get or create security group
    local security_group_id
    security_group_id=$(_ensure_security_group "$vpc_id")
    if [[ -z "$security_group_id" ]]; then
        log_error "Failed to get or create security group"
        return 1
    fi
    log_info "Using security group: $security_group_id"

    # Get SSH key name
    local key_name="spawn-$(whoami)-$(hostname)"

    # Prepare userdata for cloud-init
    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_b64
    userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    log_step "Creating Alibaba Cloud ECS instance '$name'..."
    log_step "  Instance type: $instance_type"
    log_step "  Region: $region"
    log_step "  Image: $image_id"

    local create_response
    create_response=$(aliyun ecs RunInstances \
        --InstanceName "$name" \
        --InstanceType "$instance_type" \
        --ImageId "$image_id" \
        --SecurityGroupId "$security_group_id" \
        --VSwitchId "$vswitch_id" \
        --KeyPairName "$key_name" \
        --InternetMaxBandwidthOut 1 \
        --UserData "$userdata_b64" \
        --SystemDisk.Category cloud_efficiency \
        --SystemDisk.Size 20 \
        --output json 2>&1 || echo "")

    local instance_id
    instance_id=$(echo "$create_response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    instances = data.get('InstanceIdSets', {}).get('InstanceIdSet', [])
    if instances:
        print(instances[0])
except:
    pass
" 2>/dev/null || echo "")

    if [[ -z "$instance_id" ]]; then
        log_error "Failed to create instance"
        log_error "API Error: $create_response"
        log_error ""
        log_error "Common causes:"
        log_error "  - Insufficient quota in region $region"
        log_error "  - Invalid instance type: $instance_type"
        log_error "  - Invalid image ID: $image_id"
        log_error "  - Network configuration issue (VPC/vSwitch)"
        return 1
    fi

    ALIYUN_INSTANCE_ID="$instance_id"
    export ALIYUN_INSTANCE_ID
    log_info "Instance created: $instance_id"

    # Start the instance
    log_step "Starting instance..."
    aliyun ecs StartInstance --InstanceId "$instance_id" --output json >/dev/null 2>&1

    # Wait for instance to be ready
    _wait_for_aliyun_instance "$instance_id" 60
}

# Upload file to instance
# Usage: upload_file SERVER_IP LOCAL_PATH REMOTE_PATH
upload_file() {
    local server_ip="$1"
    local local_path="$2"
    local remote_path="$3"
    # shellcheck disable=SC2086
    scp $SSH_OPTS "$local_path" "root@${server_ip}:${remote_path}"
}

# Run command on instance
# Usage: run_server SERVER_IP COMMAND
run_server() {
    local server_ip="$1"
    shift
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "root@${server_ip}" "$@"
}

# Start interactive session
# Usage: interactive_session SERVER_IP [COMMAND]
interactive_session() {
    local server_ip="$1"
    local command="${2:-bash}"
    # shellcheck disable=SC2086
    ssh $SSH_OPTS -t "root@${server_ip}" "$command"
}

verify_server_connectivity() { ssh_verify_connectivity "$@"; }
