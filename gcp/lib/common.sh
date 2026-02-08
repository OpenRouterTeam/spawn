#!/bin/bash
# Common bash functions for GCP Compute Engine spawn scripts
# Uses gcloud CLI — requires Google Cloud SDK installed and configured

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
# GCP Compute Engine specific functions
# ============================================================

# SSH_OPTS is now defined in shared/common.sh

ensure_gcloud() {
    if ! command -v gcloud &>/dev/null; then
        log_error "Google Cloud SDK (gcloud) is required."
        log_error "Install: https://cloud.google.com/sdk/docs/install"
        return 1
    fi
    # Verify auth
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q '@'; then
        log_error "gcloud not authenticated. Run: gcloud auth login"
        return 1
    fi
    # Set project
    local project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
    if [[ -z "$project" || "$project" == "(unset)" ]]; then
        log_error "No GCP project set. Run: gcloud config set project YOUR_PROJECT"
        return 1
    fi
    export GCP_PROJECT="$project"
    log_info "Using GCP project: $project"
}

ensure_ssh_key() {
    local key_path="$HOME/.ssh/id_ed25519"

    # Generate key if needed
    generate_ssh_key_if_missing "$key_path"

    # GCP handles SSH keys via project/instance metadata, added during create
    log_info "SSH key ready"
}

get_server_name() {
    if [[ -n "${GCP_INSTANCE_NAME:-}" ]]; then
        log_info "Using instance name from environment: $GCP_INSTANCE_NAME"
        echo "$GCP_INSTANCE_NAME"; return 0
    fi
    local server_name=$(safe_read "Enter instance name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Instance name is required"
        log_warn "Set GCP_INSTANCE_NAME environment variable for non-interactive usage"; return 1
    fi
    echo "$server_name"
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh
# Install Bun
su - $(logname 2>/dev/null || echo "$(whoami)") -c 'curl -fsSL https://bun.sh/install | bash' || true
# Install Claude Code
su - $(logname 2>/dev/null || echo "$(whoami)") -c 'curl -fsSL https://claude.ai/install.sh | bash' || true
# Configure PATH for all users
echo 'export PATH="$HOME/.claude/local/bin:$HOME/.bun/bin:$PATH"' >> /etc/profile.d/spawn.sh
chmod +x /etc/profile.d/spawn.sh
touch /tmp/.cloud-init-complete
CLOUD_INIT_EOF
}

create_server() {
    local name="$1"
    local machine_type="${GCP_MACHINE_TYPE:-e2-medium}"
    local zone="${GCP_ZONE:-us-central1-a}"
    local image_family="ubuntu-2404-lts-amd64"
    local image_project="ubuntu-os-cloud"

    log_warn "Creating GCP instance '$name' (type: $machine_type, zone: $zone)..."

    local userdata=$(get_cloud_init_userdata)
    local pub_key=$(cat "$HOME/.ssh/id_ed25519.pub")
    local username=$(whoami)

    gcloud compute instances create "$name" \
        --zone="$zone" \
        --machine-type="$machine_type" \
        --image-family="$image_family" \
        --image-project="$image_project" \
        --metadata="startup-script=$userdata,ssh-keys=${username}:${pub_key}" \
        --project="$GCP_PROJECT" \
        --quiet \
        >/dev/null 2>&1

    if [[ $? -ne 0 ]]; then
        log_error "Failed to create GCP instance"
        return 1
    fi

    export GCP_INSTANCE_NAME_ACTUAL="$name"
    export GCP_ZONE="$zone"

    # Get external IP
    GCP_SERVER_IP=$(gcloud compute instances describe "$name" \
        --zone="$zone" \
        --project="$GCP_PROJECT" \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null)
    export GCP_SERVER_IP

    log_info "Instance created: IP=$GCP_SERVER_IP"
}

verify_server_connectivity() {
    local ip="$1" max_attempts=${2:-30} attempt=1
    local username=$(whoami)
    log_warn "Waiting for SSH connectivity to $ip..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS -o ConnectTimeout=5 "${username}@$ip" "echo ok" >/dev/null 2>&1; then
            log_info "SSH connection established"; return 0
        fi
        log_warn "Waiting for SSH... ($attempt/$max_attempts)"; sleep 5; attempt=$((attempt + 1))
    done
    log_error "Server failed to respond via SSH after $max_attempts attempts"; return 1
}

wait_for_cloud_init() {
    local ip="$1" max_attempts=${2:-60} attempt=1
    local username=$(whoami)
    log_warn "Waiting for startup script to complete..."
    while [[ $attempt -le $max_attempts ]]; do
        if ssh $SSH_OPTS "${username}@$ip" "test -f /tmp/.cloud-init-complete" >/dev/null 2>&1; then
            log_info "Startup script completed"; return 0
        fi
        log_warn "Startup script in progress... ($attempt/$max_attempts)"; sleep 5; attempt=$((attempt + 1))
    done
    log_error "Startup script did not complete after $max_attempts attempts"; return 1
}

# GCP uses current username
run_server() {
    local ip="$1" cmd="$2"
    local username=$(whoami)
    ssh $SSH_OPTS "${username}@$ip" "$cmd"
}

upload_file() {
    local ip="$1" local_path="$2" remote_path="$3"
    local username=$(whoami)
    scp $SSH_OPTS "$local_path" "${username}@$ip:$remote_path"
}

interactive_session() {
    local ip="$1" cmd="$2"
    local username=$(whoami)
    ssh -t $SSH_OPTS "${username}@$ip" "$cmd"
}

destroy_server() {
    local name="$1"
    local zone="${GCP_ZONE:-us-central1-a}"
    log_warn "Destroying GCP instance $name..."
    gcloud compute instances delete "$name" --zone="$zone" --project="$GCP_PROJECT" --quiet >/dev/null 2>&1
    log_info "Instance $name destroyed"
}

list_servers() {
    gcloud compute instances list --project="$GCP_PROJECT" --format='table(name,zone,status,networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP,machineType.basename())'
}
