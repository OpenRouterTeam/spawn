#!/bin/bash
# Common bash functions for AWS Lightsail spawn scripts
# Uses AWS CLI (aws lightsail) — requires `aws` CLI configured with credentials

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
# AWS Lightsail specific functions
# ============================================================

# SSH_OPTS is now defined in shared/common.sh

ensure_aws_cli() {
    if ! command -v aws &>/dev/null; then
        log_error "AWS CLI is required. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
        return 1
    fi
    # Verify credentials are configured
    if ! aws sts get-caller-identity &>/dev/null; then
        log_error "AWS CLI not configured. Run: aws configure"
        return 1
    fi
    local region="${AWS_DEFAULT_REGION:-${LIGHTSAIL_REGION:-us-east-1}}"
    export AWS_DEFAULT_REGION="$region"
    log_info "Using AWS region: $region"
}

ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    local key_name="spawn-key"

    # Check if already registered
    if aws lightsail get-key-pair --key-pair-name "$key_name" &>/dev/null; then
        log_info "SSH key already registered with Lightsail"
        return 0
    fi

    log_warn "Importing SSH key to Lightsail..."
    aws lightsail import-key-pair \
        --key-pair-name "$key_name" \
        --public-key-base64 "$(base64 -w0 "$pub_path" 2>/dev/null || base64 "$pub_path")" \
        >/dev/null
    log_info "SSH key imported to Lightsail"
}

get_server_name() {
    get_resource_name "LIGHTSAIL_SERVER_NAME" "Enter Lightsail instance name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh
# Install Bun
su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'
# Install Claude Code
su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash'
# Configure PATH
echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /home/ubuntu/.bashrc
echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /home/ubuntu/.zshrc
touch /home/ubuntu/.cloud-init-complete
chown ubuntu:ubuntu /home/ubuntu/.cloud-init-complete
CLOUD_INIT_EOF
}

create_server() {
    local name="$1"
    local bundle="${LIGHTSAIL_BUNDLE:-medium_3_0}"
    local region="${AWS_DEFAULT_REGION:-us-east-1}"
    local az="${region}a"
    local blueprint="ubuntu_24_04"

    log_warn "Creating Lightsail instance '$name' (bundle: $bundle, AZ: $az)..."

    local userdata
    userdata=$(get_cloud_init_userdata)

    if ! aws lightsail create-instances \
        --instance-names "$name" \
        --availability-zone "$az" \
        --blueprint-id "$blueprint" \
        --bundle-id "$bundle" \
        --key-pair-name "spawn-key" \
        --user-data "$userdata" \
        >/dev/null; then
        log_error "Failed to create Lightsail instance"
        return 1
    fi

    export LIGHTSAIL_INSTANCE_NAME="$name"
    log_info "Instance creation initiated: $name"

    # Wait for instance to become running and get IP
    log_warn "Waiting for instance to become running..."
    local max_attempts=60 attempt=1
    while [[ $attempt -le $max_attempts ]]; do
        local state
        state=$(aws lightsail get-instance --instance-name "$name" \
            --query 'instance.state.name' --output text 2>/dev/null)

        if [[ "$state" == "running" ]]; then
            LIGHTSAIL_SERVER_IP=$(aws lightsail get-instance --instance-name "$name" \
                --query 'instance.publicIpAddress' --output text)
            export LIGHTSAIL_SERVER_IP
            log_info "Instance running: IP=$LIGHTSAIL_SERVER_IP"
            return 0
        fi
        log_warn "Instance state: $state ($attempt/$max_attempts)"
        sleep 5; attempt=$((attempt + 1))
    done
    log_error "Instance did not become running in time"; return 1
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
    local ip="$1" max_attempts=${2:-60} attempt=1
    log_warn "Waiting for cloud-init to complete..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS "ubuntu@$ip" "test -f /home/ubuntu/.cloud-init-complete" >/dev/null 2>&1; then
            log_info "Cloud-init completed"; return 0
        fi
        log_warn "Cloud-init in progress... ($attempt/$max_attempts)"; sleep 5; attempt=$((attempt + 1))
    done
    log_error "Cloud-init did not complete after $max_attempts attempts"; return 1
}

# Note: Lightsail uses 'ubuntu' user, not 'root'
run_server() { local ip="$1" cmd="$2"; ssh $SSH_OPTS "ubuntu@$ip" "$cmd"; }
upload_file() { local ip="$1" local_path="$2" remote_path="$3"; scp $SSH_OPTS "$local_path" "ubuntu@$ip:$remote_path"; }
interactive_session() { local ip="$1" cmd="$2"; ssh -t $SSH_OPTS "ubuntu@$ip" "$cmd"; }

destroy_server() {
    local name="$1"
    log_warn "Destroying Lightsail instance $name..."
    aws lightsail delete-instance --instance-name "$name" >/dev/null
    log_info "Instance $name destroyed"
}

list_servers() {
    aws lightsail get-instances --query 'instances[].{Name:name,State:state.name,IP:publicIpAddress,Bundle:bundleId}' --output table
}
