#!/bin/bash
# Common bash functions for Fly.io spawn scripts
# Uses Fly.io Machines API + flyctl CLI for provisioning and SSH access

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
# Fly.io specific functions
# ============================================================

readonly FLY_API_BASE="https://api.machines.dev/v1"
SPAWN_DASHBOARD_URL="https://fly.io/dashboard"

# Centralized curl wrapper for Fly.io Machines API
# Handles both token formats:
#   - FlyV1 tokens (from dashboard/fly tokens create): Authorization: FlyV1 fm2_...
#   - Legacy tokens (from fly auth token): Authorization: Bearer <token>
fly_api() {
    local method="$1"
    local endpoint="$2"
    local body="${3:-}"
    if [[ "$FLY_API_TOKEN" == FlyV1\ * ]]; then
        generic_cloud_api_custom_auth "$FLY_API_BASE" "$method" "$endpoint" "$body" 3 -H "Authorization: $FLY_API_TOKEN"
    else
        generic_cloud_api "$FLY_API_BASE" "$FLY_API_TOKEN" "$method" "$endpoint" "$body"
    fi
}

# Resolve the flyctl CLI command name ("fly" or "flyctl")
# Prints the command name on stdout; returns 1 if neither is found
_get_fly_cmd() {
    if command -v fly &>/dev/null; then
        echo "fly"
    elif command -v flyctl &>/dev/null; then
        echo "flyctl"
    else
        return 1
    fi
}

# Extract a top-level field from a Fly.io JSON response piped to stdin.
# Usage: echo "$json" | _fly_json_get FIELD [DEFAULT]
# Null / missing values return DEFAULT (empty string by default).
# Extract a top-level JSON field from stdin using python3 (universally available).
# Usage: echo "$json" | _fly_json_get FIELD [DEFAULT]
_fly_json_get() {
    local field="$1" default="${2:-}"
    _FIELD="$field" _DEFAULT="$default" python3 -c "
import json, sys, os
try:
    d = json.loads(sys.stdin.read())
    v = d.get(os.environ['_FIELD'])
    print(str(v) if v is not None else os.environ.get('_DEFAULT',''), end='')
except Exception:
    print(os.environ.get('_DEFAULT',''), end='')
" 2>/dev/null || printf '%s' "$default"
}

# Parse the "error" field from a Fly.io API JSON response
# Usage: echo "$response" | _fly_parse_error [DEFAULT]
_fly_parse_error() {
    local default="${1:-Unknown error}"
    _fly_json_get "error" "$default"
}

# Ensure flyctl CLI is installed
ensure_fly_cli() {
    if _get_fly_cmd &>/dev/null; then
        log_info "flyctl CLI available"
        return 0
    fi

    log_step "Installing flyctl CLI..."
    curl -L https://fly.io/install.sh | sh 2>/dev/null || {
        log_error "Failed to install flyctl CLI"
        log_error "Install manually: curl -L https://fly.io/install.sh | sh"
        return 1
    }

    # Add to PATH if installed to ~/.fly/bin
    if [[ -d "$HOME/.fly/bin" ]]; then
        export PATH="$HOME/.fly/bin:$PATH"
    fi

    if ! _get_fly_cmd &>/dev/null; then
        log_error "flyctl not found in PATH after installation"
        return 1
    fi

    log_info "flyctl CLI installed"
}

# Ensure FLY_API_TOKEN is available
# Auth chain: env var → config file → flyctl CLI → browser OAuth → manual prompt

# Try to get token from flyctl CLI if available
_try_flyctl_auth() {
    local fly_cmd
    fly_cmd=$(_get_fly_cmd) || return 1

    local token
    token=$("$fly_cmd" auth token 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' || true)
    if [[ -n "$token" ]]; then
        echo "$token"
        return 0
    fi
    return 1
}

# Sanitize a Fly.io token — the dashboard copy button may include the
# display name before the actual token (e.g. "Deploy Token FlyV1 fm2_...")
# Also handles raw macaroon tokens returned by the CLI Sessions API
# (e.g. "m2.XXXX" or "fm2_XXXX" without the "FlyV1 " prefix).
_sanitize_fly_token() {
    local raw="$1"
    # Trim leading/trailing whitespace and newlines
    raw=$(printf '%s' "$raw" | tr -d '\n\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    # If it already contains "FlyV1 ", strip any display name prefix before it
    if [[ "$raw" == *"FlyV1 "* ]]; then
        raw="FlyV1 ${raw##*FlyV1 }"
    # Raw fm2_ macaroon (no FlyV1 prefix) — extract and wrap
    elif [[ "$raw" == *"fm2_"* ]]; then
        raw=$(printf '%s' "$raw" | sed 's/.*\(fm2_[^ ]*\).*/\1/')
        raw="FlyV1 $raw"
    # Raw m2. macaroon returned by CLI Sessions API — wrap with FlyV1 prefix
    elif [[ "$raw" == m2.* ]]; then
        raw="FlyV1 $raw"
    fi
    printf '%s' "$raw"
}

# Validate a Fly.io token by making a test API call
# Also sanitizes the token in-place (strips display name prefix from dashboard copy)
_validate_fly_token() {
    # Sanitize before validating — dashboard copy button may include display name
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
    fi
    # Use api.fly.io for validation — OAuth user tokens work there.
    # The Machines API (api.machines.dev) only accepts deploy tokens.
    local response
    response=$(curl -fsSL \
        -H "Authorization: Bearer ${FLY_API_TOKEN}" \
        "https://api.fly.io/v1/user" 2>/dev/null)
    if echo "$response" | grep -q '"error"\|"errors"'; then
        # Fallback: try machines API (for deploy tokens)
        response=$(fly_api GET "/apps?org_slug=${FLY_ORG:-personal}")
    fi
    if echo "$response" | grep -q '"error"\|"errors"'; then
        log_error "Authentication failed: Invalid Fly.io API token"
        log_error "API Error: $(echo "$response" | _fly_parse_error "No details available")"
        log_error "How to fix:"
        log_warn "  1. Run: fly tokens deploy"
        log_warn "  2. Or generate a token at: https://fly.io/dashboard"
        log_warn "  3. Ensure the token has appropriate permissions"
        return 1
    fi
    return 0
}

# List Fly.io organizations via flyctl and emit pipe-delimited "slug|name (type)" lines.
# Used as the LIST_CALLBACK for interactive_pick.
_fly_list_orgs() {
    local fly_cmd
    fly_cmd=$(_get_fly_cmd 2>/dev/null) || return 1

    # Some flyctl versions exit non-zero even on success — capture regardless.
    local json
    json=$("$fly_cmd" orgs list --json 2>/dev/null)
    [[ -z "$json" ]] && return 1

    # Pass JSON as an argument (not stdin pipe) to avoid bun stdin buffering issues.
    printf '%s' "$json" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    orgs = data if isinstance(data, list) else data.get('nodes', data.get('organizations', []))
    if not orgs:
        sys.exit(1)
    for o in orgs:
        slug = o.get('slug') or o.get('name') or ''
        name = o.get('name') or slug
        otype = o.get('type') or ''
        suffix = ' (' + otype + ')' if otype else ''
        if slug:
            print(slug + '|' + name + suffix)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# Prompt user to select their Fly.io organization using the shared picker.
# Follows the same interactive_pick pattern as Hetzner/GCP pickers.
_fly_prompt_org() {
    if [[ -n "${FLY_ORG:-}" || "${SPAWN_NON_INTERACTIVE:-}" == "1" ]]; then
        return 0
    fi
    local org
    org=$(interactive_pick "FLY_ORG" "personal" "Fly.io organizations" _fly_list_orgs "personal")
    export FLY_ORG="${org:-personal}"
    log_info "Using Fly.io org: ${FLY_ORG}"
}

# Browser-based auth — delegates to flyctl when available (correct token exchange),
# falls back to a direct API prompt when flyctl is absent.
_try_fly_browser_auth() {
    local fly_cmd
    if fly_cmd=$(_get_fly_cmd 2>/dev/null); then
        # flyctl handles the full browser-flow + token exchange internally.
        # It outputs the auth URL to the terminal so sandbox users can copy it.
        log_step "Opening Fly.io browser login via flyctl..."
        if "$fly_cmd" auth login </dev/tty >/dev/tty 2>&1; then
            local token
            token=$("$fly_cmd" auth token 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g') || true
            if [[ -n "$token" ]]; then
                echo "$token"
                return 0
            fi
        fi
        log_warn "flyctl browser login failed."
        return 1
    fi

    # Fallback when flyctl is not installed: direct token entry
    log_warn "flyctl not found — cannot open browser flow automatically."
    log_warn "Generate a token at: https://fly.io/dashboard → Tokens → Create token"
    local manual_token
    manual_token=$(safe_read "Paste Fly.io API token: ") || return 1
    if [[ -n "${manual_token}" ]]; then
        echo "${manual_token}"
        return 0
    fi
    return 1
}

ensure_fly_token() {
    # 1. Try env var (sanitize — dashboard copy button may include display name)
    log_info "Checking FLY_API_TOKEN env var..."
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
        log_info "Validating token from env var..."
        _validate_fly_token && return 0
        log_warn "FLY_API_TOKEN is set but invalid, trying next method..."
        unset FLY_API_TOKEN
    else
        log_info "FLY_API_TOKEN not set, trying next method..."
    fi

    # 2. Try config file (sanitize in case it was saved with display name)
    log_info "Checking config file ~/.config/spawn/fly.json..."
    if _load_token_from_config "$HOME/.config/spawn/fly.json" "FLY_API_TOKEN" "Fly.io"; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
        log_info "Validating token from config file..."
        if _validate_fly_token; then
            return 0
        fi
        log_warn "Token from config file is invalid, trying next method..."
        unset FLY_API_TOKEN
    else
        log_info "No token found in config file, trying next method..."
    fi

    # 3. Try flyctl CLI auth
    log_info "Trying fly auth token..."
    local token
    token=$(_try_flyctl_auth 2>/dev/null) && {
        export FLY_API_TOKEN="$token"
        log_info "Using Fly.io API token from flyctl auth"
        _save_token_to_config "$HOME/.config/spawn/fly.json" "$token"
        _fly_prompt_org
        return 0
    }
    log_warn "flyctl auth token not available, trying next method..."

    # 4. Try browser-based OAuth via flyctl
    # Token from 'fly auth login' + 'fly auth token' is definitionally valid —
    # skip _validate_fly_token to avoid false failures on the Machines API.
    log_info "Opening browser for Fly.io OAuth..."
    token=$(_try_fly_browser_auth) && {
        FLY_API_TOKEN=$(_sanitize_fly_token "$token")
        export FLY_API_TOKEN
        log_info "Authenticated with Fly.io via browser"
        _save_token_to_config "$HOME/.config/spawn/fly.json" "$FLY_API_TOKEN"
        _fly_prompt_org
        return 0
    }

    # 5. Last resort: manual token entry
    log_warn "Browser login unavailable or failed, falling back to manual token entry..."
    ensure_api_token_with_provider \
        "Fly.io" \
        "FLY_API_TOKEN" \
        "$HOME/.config/spawn/fly.json" \
        "https://fly.io/dashboard → Tokens" \
        "_validate_fly_token"

    # Sanitize whatever the manual prompt gave us (may include display name)
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
        _fly_prompt_org
    fi
}

# Get the Fly.io org slug (default: personal)
get_fly_org() {
    echo "${FLY_ORG:-personal}"
}

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "FLY_APP_NAME" "Enter app name: "
}

# Create Fly.io app, returning 0 on success or if app already exists
_fly_create_app() {
    local name="$1"
    local org
    org=$(get_fly_org)

    # SECURITY: Validate org slug to prevent JSON injection via FLY_ORG env var
    if [[ ! "$org" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid FLY_ORG: must be alphanumeric with hyphens/underscores only"
        return 1
    fi

    log_step "Creating Fly.io app '$name'..."
    # SECURITY: Use json_escape to prevent JSON injection
    local app_body
    app_body=$(printf '{"app_name":%s,"org_slug":%s}' "$(json_escape "$name")" "$(json_escape "$org")")
    local response
    response=$(fly_api POST "/apps" "$app_body")

    if echo "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(echo "$response" | _fly_parse_error)
        if echo "$error_msg" | grep -qi "already exists"; then
            log_info "App '$name' already exists, reusing it"
            return 0
        fi
        # Name taken by another user — return 2 so caller can re-prompt
        if echo "$error_msg" | grep -qi "taken\|Name.*valid"; then
            log_warn "App name '$name' is not available (taken by another user or invalid)"
            return 2
        fi
        log_error "Failed to create Fly.io app"
        log_error "API Error: $error_msg"
        log_warn "Common issues:"
        log_warn "  - Invalid organization slug"
        log_warn "  - API token lacks permissions"
        return 1
    fi

    log_info "App '$name' created"
}

# Build JSON request body for Fly.io machine creation
# SECURITY: Pass values via environment variables to prevent Python injection
_fly_build_machine_body() {
    local name="$1" region="$2" vm_memory="$3"
    _FLY_NAME="$name" _FLY_REGION="$region" _FLY_MEM="$vm_memory" python3 -c "
import json, os
body = {
    'name': os.environ['_FLY_NAME'],
    'region': os.environ['_FLY_REGION'],
    'config': {
        'image': 'ubuntu:24.04',
        'guest': {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': int(os.environ['_FLY_MEM'])},
        'init': {'exec': ['/bin/sleep', 'inf']},
        'auto_destroy': False,
    },
}
print(json.dumps(body))
"
}

# Create a Fly.io machine via the Machines API
# Sets FLY_MACHINE_ID and FLY_APP_NAME on success
_fly_create_machine() {
    local name="$1"
    local region="$2"
    local vm_memory="$3"

    log_step "Creating Fly.io machine (region: $region, memory: ${vm_memory}MB)..."

    local machine_body
    machine_body=$(_fly_build_machine_body "$name" "$region" "$vm_memory")

    local response
    response=$(fly_api POST "/apps/$name/machines" "$machine_body")

    if echo "$response" | grep -q '"error"'; then
        log_error "Failed to create Fly.io machine"
        log_error "API Error: $(echo "$response" | _fly_parse_error)"
        log_warn "Common issues:"
        log_warn "  - Insufficient account balance or payment method required"
        log_warn "  - Region unavailable (try different FLY_REGION)"
        log_warn "  - Machine limit reached"
        log_warn "Check your dashboard: https://fly.io/dashboard"
        return 1
    fi

    FLY_MACHINE_ID=$(echo "$response" | _fly_json_get "id")
    if [[ -z "$FLY_MACHINE_ID" ]]; then
        log_error "Failed to extract machine ID from API response"
        log_error "Response: $response"
        return 1
    fi
    export FLY_MACHINE_ID FLY_APP_NAME="$name"
    log_info "Machine created: ID=$FLY_MACHINE_ID, App=$name"
}

# Wait for a Fly.io machine to reach "started" state using the /wait endpoint.
# Blocks server-side — one API call instead of a polling loop (#1569).
# Usage: _fly_wait_for_machine_start APP_NAME MACHINE_ID [TIMEOUT_SECS]
_fly_wait_for_machine_start() {
    local name="$1"
    local machine_id="$2"
    local timeout="${3:-90}"

    log_step "Waiting for machine to start (timeout: ${timeout}s)..."
    local response
    response=$(fly_api GET "/apps/$name/machines/$machine_id/wait?state=started&timeout=$timeout")

    if echo "$response" | grep -q '"error"'; then
        log_error "Machine did not reach 'started' state: $(echo "$response" | _fly_parse_error)"
        log_error "Check status:     fly machines list -a $name"
        log_error "Try a new region: FLY_REGION=ord spawn fly <agent>"
        log_error "Dashboard:        https://fly.io/dashboard"
        return 1
    fi
    log_info "Machine is running"
}

# Create a Fly.io app and machine
create_server() {
    local name="$1"
    local region="${FLY_REGION:-iad}"
    local vm_size="${FLY_VM_SIZE:-shared-cpu-1x}"
    local vm_memory="${FLY_VM_MEMORY:-1024}"

    # Validate env var inputs to prevent injection into Python code
    validate_region_name "$region" || { log_error "Invalid FLY_REGION"; return 1; }
    validate_resource_name "$vm_size" || { log_error "Invalid FLY_VM_SIZE"; return 1; }
    if [[ ! "$vm_memory" =~ ^[0-9]+$ ]]; then log_error "Invalid FLY_VM_MEMORY: must be numeric"; return 1; fi

    local create_rc=0 collision_attempts=0
    _fly_create_app "$name" || create_rc=$?
    while [[ "$create_rc" -eq 2 ]]; do
        collision_attempts=$((collision_attempts + 1))
        if [[ "$collision_attempts" -ge 5 ]]; then
            log_error "Too many name collisions. Set a unique name with: FLY_APP_NAME=my-unique-name"
            return 1
        fi
        log_warn "App name '$name' is taken — Fly.io app names are globally unique."
        name=$(safe_read "Enter a different app name: ") || return 1
        [[ -z "$name" ]] && { log_error "App name cannot be empty"; return 1; }
        create_rc=0
        _fly_create_app "$name" || create_rc=$?
    done
    if [[ "$create_rc" -ne 0 ]]; then return 1; fi
    _fly_create_machine "$name" "$region" "$vm_memory" || return 1
    _fly_wait_for_machine_start "$name" "$FLY_MACHINE_ID"

    save_vm_connection "fly-ssh" "root" "${FLY_MACHINE_ID}" "$name" "fly"
}

# Retry a run_server command up to N times with sleep between attempts.
# Usage: _fly_run_with_retry MAX_ATTEMPTS SLEEP_SEC TIMEOUT CMD
_fly_run_with_retry() {
    local max_attempts="${1:-3}"
    local sleep_sec="${2:-5}"
    local timeout_secs="${3:-120}"
    local cmd="${4}"
    local attempt=1
    while [ "$attempt" -le "$max_attempts" ]; do
        if run_server "$cmd" "$timeout_secs"; then
            return 0
        fi
        log_warn "Command failed (attempt $attempt/$max_attempts): $cmd"
        attempt=$((attempt + 1))
        [ "$attempt" -le "$max_attempts" ] && sleep "$sleep_sec"
    done
    log_error "Command failed after $max_attempts attempts: $cmd"
    return 1
}

# Wait for SSH to be reachable on the Fly.io machine
_fly_wait_for_ssh() {
    local max_attempts="${1:-20}"
    local attempt=1
    log_step "Waiting for SSH connectivity..."
    while [[ "$attempt" -le "$max_attempts" ]]; do
        local output=""
        output=$(run_server "echo ok" 15 2>/dev/null) || true
        if [[ "$output" == *"ok"* ]]; then
            log_info "SSH is ready"
            return 0
        fi
        log_step "SSH not ready yet ($attempt/$max_attempts)"
        sleep 5
        attempt=$((attempt + 1))
    done
    log_error "SSH connectivity failed after $max_attempts attempts"
    log_error "The machine may need more time. Try: fly ssh console -a $FLY_APP_NAME"
    return 1
}

# Wait for base tools to be installed (Fly.io uses bare Ubuntu image)
wait_for_cloud_init() {
    _fly_wait_for_ssh || return 1

    log_step "Installing packages (this may take 1-2 minutes)..."
    _fly_run_with_retry 3 10 600 "apt-get update -y && apt-get install -y curl unzip git zsh python3 python3-pip build-essential" || {
        log_warn "Full package install failed after retries, trying minimal set..."
        _fly_run_with_retry 2 5 300 "apt-get install -y curl git" || true
    }
    log_step "Installing Node.js..."
    _fly_run_with_retry 3 10 120 "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" || {
        log_warn "Node.js install failed after retries, npm-based agents may not work"
    }
    log_step "Installing bun..."
    _fly_run_with_retry 2 5 120 "curl -fsSL https://bun.sh/install | bash" || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' 30 || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' 30 || true
    log_info "Base tools installed"
}

# Run a command on the Fly.io machine.
# Uses 'fly machine exec' (direct API, no WireGuard tunnel) when FLY_MACHINE_ID
# is set (#1570). Falls back to 'fly ssh console -C' otherwise.
# Optional second arg: timeout in seconds.
run_server() {
    local cmd="$1"
    local timeout_secs="${2:-}"
    local full_cmd="export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\" && $cmd"

    local fly_cmd
    fly_cmd=$(_get_fly_cmd)

    local timeout_bin=""
    if command -v timeout &>/dev/null; then timeout_bin="timeout"
    elif command -v gtimeout &>/dev/null; then timeout_bin="gtimeout"; fi

    # fly machine exec: direct API execution, no WireGuard tunnel overhead
    if [[ -n "${FLY_MACHINE_ID:-}" ]]; then
        if [[ -n "${timeout_secs}" && -n "${timeout_bin}" ]]; then
            "${timeout_bin}" "${timeout_secs}" \
                "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
                -- bash -c "$full_cmd"
            return $?
        fi
        "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
            -- bash -c "$full_cmd"
        return $?
    fi

    # Fallback: fly ssh console (WireGuard tunnel)
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$full_cmd")
    if [[ -n "${timeout_secs}" && -n "${timeout_bin}" ]]; then
        "${timeout_bin}" "${timeout_secs}" \
            "$fly_cmd" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd" --quiet
        return $?
    fi
    "$fly_cmd" ssh console -a "$FLY_APP_NAME" -C "bash -c $escaped_cmd" --quiet
}

# Upload a file to the machine via stdin pipe — avoids embedding file content
# in a shell command string (#1580). Uses fly machine exec with stdin when
# FLY_MACHINE_ID is available; falls back to base64 via ssh console.
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    # SECURITY: Strict allowlist validation — only safe path characters
    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    local fly_cmd
    fly_cmd=$(_get_fly_cmd)

    # Preferred: stream file via stdin to fly machine exec (no size limit, no injection)
    if [[ -n "${FLY_MACHINE_ID:-}" ]]; then
        "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
            -- bash -c "cat > $(printf '%q' "$remote_path")" \
            < "$local_path"
        return $?
    fi

    # Fallback: base64 encode and decode via ssh console
    local content
    content=$(base64 -w0 < "$local_path" 2>/dev/null || base64 < "$local_path")
    if [[ "${content}" =~ [^A-Za-z0-9+/=] ]]; then
        log_error "upload_file: base64 output contains unexpected characters"
        return 1
    fi
    run_server "printf '%s' '${content}' | base64 -d > '${remote_path}'"
}

# Start an interactive SSH session on the Fly.io machine
interactive_session() {
    local cmd="$1"
    # Wrap in bash -c with PATH prepended (same as run_server) so shell builtins
    # like "source" work — fly ssh console -C execs directly, not via a shell.
    local full_cmd="export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\" && $cmd"
    # printf '%q' makes the command a single shell word; the remote shell
    # unescapes it back into the original command for bash -c.
    # Do NOT add quotes around $escaped_cmd (see run_server comment).
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$full_cmd")
    local session_exit=0
    # --pty allocates a pseudo-terminal so interactive TUI agents (claude, codex)
    # receive a proper TTY on stdin.  Without it, fly ssh console -C runs the
    # command without a PTY and agents see "Input is not a terminal (fd=0)".
    "$(_get_fly_cmd)" ssh console -a "$FLY_APP_NAME" --pty -C "bash -c $escaped_cmd" || session_exit=$?
    SERVER_NAME="${FLY_APP_NAME:-}" SPAWN_RECONNECT_CMD="fly ssh console -a ${FLY_APP_NAME:-}" \
        _show_exec_post_session_summary
    return "${session_exit}"
}

# Destroy a Fly.io machine and app (#1577: errors are now reported, not swallowed)
destroy_server() {
    local app_name="${1:-$FLY_APP_NAME}"
    if [[ -z "$app_name" ]]; then
        log_error "destroy_server: no app name provided"
        return 1
    fi

    log_step "Destroying Fly.io app '$app_name'..."

    local machines
    machines=$(fly_api GET "/apps/$app_name/machines")

    local machine_ids
    machine_ids=$(printf '%s' "$machines" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    for m in (data if isinstance(data, list) else []):
        print(m['id'])
except Exception:
    pass
" 2>/dev/null || true)

    local failed=0
    for mid in $machine_ids; do
        log_step "Stopping machine $mid..."
        fly_api POST "/apps/$app_name/machines/$mid/stop" '{}' >/dev/null || true
        sleep 2
        log_step "Destroying machine $mid..."
        fly_api DELETE "/apps/$app_name/machines/$mid?force=true" >/dev/null || failed=1
    done

    local delete_response
    delete_response=$(fly_api DELETE "/apps/$app_name" 2>&1)
    if echo "$delete_response" | grep -q '"error"'; then
        log_error "Failed to delete app '$app_name': $(echo "$delete_response" | _fly_parse_error)"
        return 1
    fi

    [[ "$failed" -eq 1 ]] && log_warn "Some machines may not have been fully destroyed — check: fly machines list -a $app_name"
    log_info "App '$app_name' destroyed"
}

# List all Fly.io apps and machines
list_servers() {
    local org
    org=$(get_fly_org)
    local response
    response=$(fly_api GET "/apps?org_slug=$org")

    printf '%s' "$response" | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    apps = data if isinstance(data, list) else data.get('apps', [])
    if not apps:
        print('No apps found')
        sys.exit(0)
    print('{:<25}{:<20}{:<12}{:<20}'.format('NAME','ID','STATUS','NETWORK'))
    print('-' * 77)
    for a in apps:
        print('{:<25}{:<20}{:<12}{:<20}'.format(
            a.get('name','N/A')[:24], a.get('id','N/A')[:19],
            a.get('status','N/A')[:11], a.get('network','N/A')[:19]))
except Exception as e:
    print('Error listing apps:', e)
" 2>/dev/null
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { prompt_spawn_name; ensure_fly_cli; ensure_fly_token; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { wait_for_cloud_init; }
cloud_run() { run_server "$1"; }
cloud_upload() { upload_file "$1" "$2"; }
cloud_interactive() { interactive_session "$1"; }
cloud_label() { echo "Fly.io machine"; }
