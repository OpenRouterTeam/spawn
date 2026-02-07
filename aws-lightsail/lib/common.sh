#!/bin/bash
# Common bash functions for AWS Lightsail spawn scripts
# Uses AWS CLI (aws lightsail) — requires `aws` CLI configured with credentials

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
# AWS Lightsail specific functions
# ============================================================

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $HOME/.ssh/id_ed25519"

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
    local key_path="$HOME/.ssh/id_ed25519" pub_path="${key_path}.pub"
    if [[ ! -f "$key_path" ]]; then
        log_warn "Generating SSH key..."
        mkdir -p "$HOME/.ssh"
        ssh-keygen -t ed25519 -f "$key_path" -N "" -q
        log_info "SSH key generated at $key_path"
    fi
    local pub_key=$(cat "$pub_path")
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
    if [[ -n "$LIGHTSAIL_SERVER_NAME" ]]; then
        log_info "Using instance name from environment: $LIGHTSAIL_SERVER_NAME"
        echo "$LIGHTSAIL_SERVER_NAME"; return 0
    fi
    local server_name=$(safe_read "Enter Lightsail instance name: ")
    if [[ -z "$server_name" ]]; then
        log_error "Instance name is required"
        log_warn "Set LIGHTSAIL_SERVER_NAME environment variable for non-interactive usage"; return 1
    fi
    echo "$server_name"
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

    local userdata=$(get_cloud_init_userdata)

    aws lightsail create-instances \
        --instance-names "$name" \
        --availability-zone "$az" \
        --blueprint-id "$blueprint" \
        --bundle-id "$bundle" \
        --key-pair-name "spawn-key" \
        --user-data "$userdata" \
        >/dev/null

    if [[ $? -ne 0 ]]; then
        log_error "Failed to create Lightsail instance"
        return 1
    fi

    export LIGHTSAIL_INSTANCE_NAME="$name"
    log_info "Instance creation initiated: $name"

    # Wait for instance to become running and get IP
    log_warn "Waiting for instance to become running..."
    local max_attempts=60 attempt=1
    while [[ $attempt -le $max_attempts ]]; do
        local state=$(aws lightsail get-instance --instance-name "$name" \
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
