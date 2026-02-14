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

SPAWN_DASHBOARD_URL="https://ecs.console.aliyun.com/"

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

# Load Alibaba Cloud credentials from env vars, config file, or user prompt.
# Outputs three tab-separated values: ak_id, ak_secret, region
# Usage: creds=$(_aliyun_load_or_prompt_credentials)
_aliyun_load_or_prompt_credentials() {
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

    printf '%s\t%s\t%s' "$ak_id" "$ak_secret" "$region"
}

# Configure the aliyun CLI with the given credentials and verify them.
# Usage: _aliyun_configure_cli AK_ID AK_SECRET REGION
_aliyun_configure_cli() {
    local ak_id="$1" ak_secret="$2" region="$3"

    log_step "Configuring Alibaba Cloud CLI..."
    aliyun configure set \
        --mode AK \
        --access-key-id "$ak_id" \
        --access-key-secret "$ak_secret" \
        --region "$region" \
        --language en

    if test_aliyun_credentials; then
        return 0
    else
        log_error "Credential configuration failed"
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

    local creds ak_id ak_secret region
    creds=$(_aliyun_load_or_prompt_credentials) || return 1
    IFS=$'\t' read -r ak_id ak_secret region <<< "$creds"

    _aliyun_configure_cli "$ak_id" "$ak_secret" "$region"
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

# ============================================================
# JSON parsing helpers
# ============================================================

# Extract a field from the first item in a nested JSON list.
# Usage: _aliyun_json_field JSON_STRING OUTER_KEY INNER_KEY FIELD_NAME
# Example: _aliyun_json_field "$response" "Vpcs" "Vpc" "VpcId"
_aliyun_json_field() {
    local json="$1" outer="$2" inner="$3" field="$4"
    echo "$json" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    items = data.get('$outer', {}).get('$inner', [])
    if items:
        print(items[0].get('$field', ''))
except:
    pass
" 2>/dev/null || echo ""
}

# Extract a top-level field from a JSON response.
# Usage: _aliyun_json_top_field JSON_STRING FIELD_NAME
_aliyun_json_top_field() {
    local json="$1" field="$2"
    echo "$json" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get('$field', ''))
except:
    pass
" 2>/dev/null || echo ""
}

# Extract the first element from a nested list of primitives (strings/numbers).
# Unlike _aliyun_json_field which expects a list of dicts, this handles flat lists.
# Usage: _aliyun_json_list_first JSON_STRING OUTER_KEY INNER_KEY
# Example: _aliyun_json_list_first "$response" "InstanceIdSets" "InstanceIdSet"
_aliyun_json_list_first() {
    local json="$1" outer="$2" inner="$3"
    echo "$json" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    items = data.get('$outer', {}).get('$inner', [])
    if items:
        print(items[0])
except:
    pass
" 2>/dev/null || echo ""
}

# ============================================================
# Network resource helpers
# ============================================================

# Get or create a VPC in the current region.
# Prints the VPC ID on success.
# Usage: _ensure_vpc
_ensure_vpc() {
    log_step "Checking for VPC..."
    local response
    response=$(aliyun ecs DescribeVpcs --output json 2>/dev/null || echo "{}")
    local vpc_id
    vpc_id=$(_aliyun_json_field "$response" "Vpcs" "Vpc" "VpcId")

    if [[ -n "$vpc_id" ]]; then
        echo "$vpc_id"
        return 0
    fi

    log_step "Creating VPC..."
    response=$(aliyun ecs CreateVpc \
        --CidrBlock "172.16.0.0/12" \
        --VpcName "spawn-vpc" \
        --output json 2>&1 || echo "")
    vpc_id=$(_aliyun_json_top_field "$response" "VpcId")

    if [[ -z "$vpc_id" ]]; then
        log_error "Failed to create VPC: $response"
        return 1
    fi
    sleep 3  # Wait for VPC to be ready
    echo "$vpc_id"
}

# Get or create a vSwitch in the given VPC.
# Prints the vSwitch ID on success.
# Usage: _ensure_vswitch VPC_ID
_ensure_vswitch() {
    local vpc_id="$1"

    log_step "Checking for vSwitch..."
    local response
    response=$(aliyun ecs DescribeVSwitches --VpcId "$vpc_id" --output json 2>/dev/null || echo "{}")
    local vswitch_id
    vswitch_id=$(_aliyun_json_field "$response" "VSwitches" "VSwitch" "VSwitchId")

    if [[ -n "$vswitch_id" ]]; then
        echo "$vswitch_id"
        return 0
    fi

    # Get first availability zone
    local zone_response zone_id
    zone_response=$(aliyun ecs DescribeZones --output json 2>/dev/null || echo "{}")
    zone_id=$(_aliyun_json_field "$zone_response" "Zones" "Zone" "ZoneId")

    if [[ -z "$zone_id" ]]; then
        log_error "Failed to get availability zone"
        return 1
    fi

    log_step "Creating vSwitch in zone $zone_id..."
    response=$(aliyun ecs CreateVSwitch \
        --VpcId "$vpc_id" \
        --ZoneId "$zone_id" \
        --CidrBlock "172.16.0.0/24" \
        --VSwitchName "spawn-vswitch" \
        --output json 2>&1 || echo "")
    vswitch_id=$(_aliyun_json_top_field "$response" "VSwitchId")

    if [[ -z "$vswitch_id" ]]; then
        log_error "Failed to create vSwitch: $response"
        return 1
    fi
    sleep 3  # Wait for vSwitch to be ready
    echo "$vswitch_id"
}

# ============================================================
# Instance lifecycle
# ============================================================

# Extract the first instance ID from a RunInstances response.
# The ID is nested at InstanceIdSets.InstanceIdSet[0] (a flat string list).
# Usage: id=$(_aliyun_extract_instance_id "$response")
_aliyun_extract_instance_id() {
    _aliyun_json_list_first "$1" "InstanceIdSets" "InstanceIdSet"
}

# Ensure VPC, vSwitch, and security group exist, printing their IDs.
# Sets caller-visible variables via nameref-style printf.
# Usage: read -r vpc_id vswitch_id sg_id < <(_ensure_network_infrastructure)
_ensure_network_infrastructure() {
    local vpc_id
    vpc_id=$(_ensure_vpc) || return 1
    log_info "Using VPC: $vpc_id"

    local vswitch_id
    vswitch_id=$(_ensure_vswitch "$vpc_id") || return 1
    log_info "Using vSwitch: $vswitch_id"

    local security_group_id
    security_group_id=$(_ensure_security_group "$vpc_id") || return 1
    log_info "Using security group: $security_group_id"

    printf '%s\t%s\t%s' "$vpc_id" "$vswitch_id" "$security_group_id"
}

# Extract the first public IP from an Alibaba Cloud DescribeInstances response.
# The IP is nested at Instances.Instance[0].PublicIpAddress.IpAddress[0].
# Usage: ip=$(_aliyun_instance_public_ip "$response")
_aliyun_instance_public_ip() {
    local json="$1"
    echo "$json" | python3 -c "
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
" 2>/dev/null || echo ""
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

        local status
        status=$(_aliyun_json_field "$response" "Instances" "Instance" "Status")

        local ip_address
        ip_address=$(_aliyun_instance_public_ip "$response")

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
# Prints the security group ID on success.
# Usage: _ensure_security_group VPC_ID
_ensure_security_group() {
    local vpc_id="$1"
    local sg_name="${ALIYUN_SECURITY_GROUP_NAME:-spawn-default}"

    local response
    response=$(aliyun ecs DescribeSecurityGroups \
        --VpcId "$vpc_id" \
        --SecurityGroupName "$sg_name" \
        --output json 2>/dev/null || echo "{}")

    local sg_id
    sg_id=$(_aliyun_json_field "$response" "SecurityGroups" "SecurityGroup" "SecurityGroupId")

    if [[ -n "$sg_id" ]]; then
        echo "$sg_id"
        return 0
    fi

    log_step "Creating security group '$sg_name'..."
    response=$(aliyun ecs CreateSecurityGroup \
        --VpcId "$vpc_id" \
        --SecurityGroupName "$sg_name" \
        --Description "Created by spawn for AI agent instances" \
        --output json 2>&1 || echo "")

    sg_id=$(_aliyun_json_top_field "$response" "SecurityGroupId")

    if [[ -z "$sg_id" ]]; then
        log_error "Failed to create security group: $response"
        return 1
    fi

    log_step "Adding SSH rule to security group..."
    aliyun ecs AuthorizeSecurityGroup \
        --SecurityGroupId "$sg_id" \
        --IpProtocol tcp \
        --PortRange "22/22" \
        --SourceCidrIp "0.0.0.0/0" \
        --output json >/dev/null 2>&1

    echo "$sg_id"
}

# Validate Alibaba Cloud ECS instance parameters
_aliyun_validate_create_params() {
    local instance_type="$1" region="$2" image_id="$3"
    validate_resource_name "$instance_type" || { log_error "Invalid ALIYUN_INSTANCE_TYPE"; return 1; }
    validate_region_name "$region" || { log_error "Invalid ALIYUN_REGION"; return 1; }
    validate_resource_name "$image_id" || { log_error "Invalid ALIYUN_IMAGE_ID"; return 1; }
}

# Run the aliyun ecs RunInstances API call, returning the instance ID or failing
_aliyun_run_instances() {
    local name="$1" instance_type="$2" image_id="$3" region="$4"
    local security_group_id="$5" vswitch_id="$6" key_name="$7" userdata_b64="$8"

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
    instance_id=$(_aliyun_extract_instance_id "$create_response")

    if [[ -z "$instance_id" ]]; then
        _log_diagnostic \
            "Failed to create Alibaba Cloud ECS instance" \
            "Insufficient quota in region $region" \
            "Invalid instance type: $instance_type" \
            "Invalid image ID: $image_id" \
            "Network configuration issue (VPC/vSwitch)" \
            --- \
            "Check your quotas in the Alibaba Cloud console" \
            "Verify instance type availability in your region" \
            "Review the API error: $create_response"
        return 1
    fi

    echo "$instance_id"
}

# Create Alibaba Cloud ECS instance
# Sets: ALIYUN_INSTANCE_ID, ALIYUN_INSTANCE_IP
create_server() {
    local name="$1"
    local region="${ALIYUN_REGION:-cn-hangzhou}"
    local instance_type="${ALIYUN_INSTANCE_TYPE:-ecs.t5-lc1m2.small}"
    local image_id="${ALIYUN_IMAGE_ID:-ubuntu_24_04_x64_20G_alibase_20240812.vhd}"

    _aliyun_validate_create_params "$instance_type" "$region" "$image_id" || return 1

    # Ensure network infrastructure (VPC, vSwitch, security group)
    local net_info vpc_id vswitch_id security_group_id
    net_info=$(_ensure_network_infrastructure) || return 1
    IFS=$'\t' read -r vpc_id vswitch_id security_group_id <<< "$net_info"

    # Prepare instance parameters
    local key_name="spawn-$(whoami)-$(hostname)"
    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_b64
    userdata_b64=$(echo "$userdata" | base64 -w0 2>/dev/null || echo "$userdata" | base64)

    log_step "Creating Alibaba Cloud ECS instance '$name'..."
    log_step "  Instance type: $instance_type"
    log_step "  Region: $region"
    log_step "  Image: $image_id"

    local instance_id
    instance_id=$(_aliyun_run_instances "$name" "$instance_type" "$image_id" "$region" \
        "$security_group_id" "$vswitch_id" "$key_name" "$userdata_b64") || return 1

    ALIYUN_INSTANCE_ID="$instance_id"
    export ALIYUN_INSTANCE_ID
    log_info "Instance created: $instance_id"

    # Start the instance
    log_step "Starting instance..."
    aliyun ecs StartInstance --InstanceId "$instance_id" --output json >/dev/null 2>&1

    # Wait for instance to be ready
    _wait_for_aliyun_instance "$instance_id" 60
}

# Standard SSH operations (delegates to shared helpers in shared/common.sh)
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
