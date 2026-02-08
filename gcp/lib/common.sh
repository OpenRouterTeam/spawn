#!/bin/bash
# Common bash functions for GCP Compute Engine spawn scripts
# Uses gcloud CLI — requires Google Cloud SDK installed and configured

# ============================================================
# Provider-agnostic functions
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}$1${NC}" >&2; }
log_warn() { echo -e "${YELLOW}$1${NC}" >&2; }
log_error() { echo -e "${RED}$1${NC}" >&2; }

safe_read() {
    local prompt="$1" result=""
    if [[ -t 0 ]]; then read -p "$prompt" result
    elif echo -n "" > /dev/tty 2>/dev/null; then read -p "$prompt" result < /dev/tty
    else log_error "Cannot read input: no TTY available"; return 1; fi
    echo "$result"
}

nc_listen() {
    local port=$1; shift
    if nc --help 2>&1 | grep -q "BusyBox\|busybox"; then
        nc -l -p "$port" "$@"
    else nc -l "$port" "$@"; fi
}

open_browser() {
    local url=$1
    if command -v termux-open-url &>/dev/null; then termux-open-url "$url" </dev/null
    elif command -v open &>/dev/null; then open "$url" </dev/null
    elif command -v xdg-open &>/dev/null; then xdg-open "$url" </dev/null
    else log_warn "Please open: ${url}"; fi
}

get_openrouter_api_key_manual() {
    echo ""; log_warn "Manual API Key Entry"
    echo -e "${YELLOW}Get your API key from: https://openrouter.ai/settings/keys${NC}"; echo ""
    local api_key=""
    while [[ -z "$api_key" ]]; do
        api_key=$(safe_read "Enter your OpenRouter API key: ") || return 1
        if [[ -z "$api_key" ]]; then log_error "API key cannot be empty"
        elif [[ ! "$api_key" =~ ^sk-or-v1-[a-f0-9]{64}$ ]]; then
            log_warn "Warning: API key format doesn't match expected pattern (sk-or-v1-...)"
            local confirm=$(safe_read "Use this key anyway? (y/N): ") || return 1
            if [[ "$confirm" =~ ^[Yy]$ ]]; then break; else api_key=""; fi
        fi
    done
    log_info "API key accepted!"; echo "$api_key"
}

try_oauth_flow() {
    local callback_port=${1:-5180}
    log_warn "Attempting OAuth authentication..."
    if ! command -v nc &>/dev/null; then log_warn "netcat (nc) not found"; return 1; fi
    local callback_url="http://localhost:${callback_port}/callback"
    local auth_url="https://openrouter.ai/auth?callback_url=${callback_url}"
    local oauth_dir=$(mktemp -d) code_file="$oauth_dir/code"
    log_warn "Starting local OAuth server on port ${callback_port}..."

    # Write the HTTP response to a file (using printf for macOS bash 3.x compat)
    local response_tpl="$oauth_dir/response.http"
    printf 'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e}.card{text-align:center;color:#fff}h1{color:#00d4aa}p{color:#ffffffcc}</style></head><body><div class="card"><h1>Authentication Successful!</h1><p>You can close this tab</p></div><script>setTimeout(function(){try{window.close()}catch(e){}},3000)</script></body></html>' > "$response_tpl"
    
    # Background listener
    (
        while true; do
            request=$(nc_listen "$callback_port" < "$response_tpl" 2>/dev/null | head -1) || break
            
            case "$request" in
                *"/callback?code="*)
                    echo "$request" | sed -n 's/.*code=\([^ &]*\).*/\1/p' > "$code_file"
                    break
                    ;;
            esac
        done
    ) </dev/null &
    local server_pid=$!; sleep 1
    if ! kill -0 $server_pid 2>/dev/null; then log_warn "Failed to start OAuth server"; rm -rf "$oauth_dir"; return 1; fi
    log_warn "Opening browser to authenticate with OpenRouter..."; open_browser "$auth_url"
    local timeout=120 elapsed=0
    while [[ ! -f "$code_file" ]] && [[ $elapsed -lt $timeout ]]; do sleep 1; elapsed=$((elapsed + 1)); done
    kill $server_pid 2>/dev/null || true; wait $server_pid 2>/dev/null || true
    if [[ ! -f "$code_file" ]]; then log_warn "OAuth timeout"; rm -rf "$oauth_dir"; return 1; fi
    local oauth_code=$(cat "$code_file"); rm -rf "$oauth_dir"
    log_warn "Exchanging OAuth code for API key..."
    local key_response=$(curl -s -X POST "https://openrouter.ai/api/v1/auth/keys" \
        -H "Content-Type: application/json" -d "{\"code\": \"$oauth_code\"}")
    local api_key=$(echo "$key_response" | grep -o '"key":"[^"]*"' | sed 's/"key":"//;s/"$//')
    if [[ -z "$api_key" ]]; then log_error "Failed to exchange OAuth code: ${key_response}"; return 1; fi
    log_info "Successfully obtained OpenRouter API key via OAuth!"; echo "$api_key"
}

get_openrouter_api_key_oauth() {
    local callback_port=${1:-5180}
    local api_key=$(try_oauth_flow "$callback_port")
    if [[ -n "$api_key" ]]; then echo "$api_key"; return 0; fi
    echo ""; log_warn "OAuth authentication failed or unavailable"
    log_warn "You can enter your API key manually instead"; echo ""
    local manual_choice=$(safe_read "Would you like to enter your API key manually? (Y/n): ") || {
        log_error "Cannot prompt for manual entry in non-interactive mode"
        log_warn "Set OPENROUTER_API_KEY environment variable for non-interactive usage"; return 1
    }
    if [[ ! "$manual_choice" =~ ^[Nn]$ ]]; then
        api_key=$(get_openrouter_api_key_manual); echo "$api_key"; return 0
    else log_error "Authentication cancelled by user"; return 1; fi
}

# ============================================================
# GCP Compute Engine specific functions
# ============================================================

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

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
    local key_path="$HOME/.ssh/id_ed25519" pub_path="${key_path}.pub"
    if [[ ! -f "$key_path" ]]; then
        log_warn "Generating SSH key..."
        mkdir -p "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$key_path" -N "" -q
        log_info "SSH key generated at $key_path"
    fi
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
