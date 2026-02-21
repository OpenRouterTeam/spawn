#!/bin/bash
# Common bash functions for Fly.io spawn scripts
# Uses Fly.io Machines API + flyctl CLI for provisioning and SSH access

# Bash safety flags
set -eo pipefail

# ============================================================
# Source shared provider-agnostic functions (local or remote)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../../shared/common.sh" ]]; then
    source "$SCRIPT_DIR/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# ============================================================
# Fly.io constants
# ============================================================

readonly FLY_API_BASE="https://api.machines.dev/v1"
SPAWN_DASHBOARD_URL="https://fly.io/dashboard"

# ============================================================
# Helpers
# ============================================================

# Centralized curl wrapper for Fly.io Machines API.
# Dispatches FlyV1 vs Bearer based on token format.
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

# Resolve the flyctl CLI command name ("fly" or "flyctl").
# Prints the command name on stdout; returns 1 if neither is found.
_get_fly_cmd() {
    if command -v fly &>/dev/null; then
        echo "fly"
    elif command -v flyctl &>/dev/null; then
        echo "flyctl"
    else
        return 1
    fi
}

# Extract a top-level field from a JSON string via stdin.
# Uses bun for JSON parsing — no eval, no env var size limits.
# Usage: printf '%s' "$json" | _fly_json FIELD [DEFAULT]
_fly_json() {
    local field="$1" default="${2:-}"
    bun -e '
const d = JSON.parse(await Bun.stdin.text());
const v = d[process.argv[1]];
process.stdout.write(v != null ? String(v) : (process.argv[2] ?? ""));
' -- "$field" "$default" 2>/dev/null || printf '%s' "$default"
}

# Extract machine IDs from a JSON array of machine objects via stdin.
# Usage: printf '%s' "$json" | _fly_json_ids
# Outputs one ID per line.
_fly_json_ids() {
    bun -e '
const d = JSON.parse(await Bun.stdin.text());
for (const m of (Array.isArray(d) ? d : [])) process.stdout.write(m.id + "\n");
' 2>/dev/null || true
}

# ============================================================
# Authentication
# ============================================================

# Sanitize a Fly.io token — trim whitespace, extract/wrap macaroon tokens.
# The dashboard copy button may include the display name before the token.
_sanitize_fly_token() {
    local raw="$1"
    raw=$(printf '%s' "$raw" | tr -d '\n\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [[ "$raw" == *"FlyV1 "* ]]; then
        raw="FlyV1 ${raw##*FlyV1 }"
    elif [[ "$raw" == *"fm2_"* ]]; then
        raw=$(printf '%s' "$raw" | sed 's/.*\(fm2_[^ ,]*\).*/\1/')
        raw="FlyV1 $raw"
    elif [[ "$raw" == m2.* ]]; then
        raw="FlyV1 $raw"
    fi
    printf '%s' "$raw"
}

# Validate a Fly.io token by making a test API call.
# Sanitizes the token first. Tries Machines API (for deploy tokens),
# falls back to api.fly.io/v1/user (for OAuth/personal tokens).
_test_fly_token() {
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
    fi
    # Try Machines API first (deploy tokens — most common)
    local response
    response=$(fly_api GET "/apps?org_slug=${FLY_ORG:-personal}")
    if ! printf '%s' "$response" | grep -q '"error"\|"errors"'; then
        return 0
    fi
    # Fallback: user API (OAuth/personal tokens)
    response=$(curl -sS \
        -H "Authorization: Bearer ${FLY_API_TOKEN}" \
        "https://api.fly.io/v1/user" 2>/dev/null) || true
    if [[ -n "$response" ]] && ! printf '%s' "$response" | grep -q '"error"\|"errors"'; then
        return 0
    fi
    log_error "Authentication failed: Invalid Fly.io API token"
    log_error "How to fix:"
    log_warn "  1. Run: fly tokens deploy"
    log_warn "  2. Or generate a token at: https://fly.io/dashboard"
    return 1
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

    if [[ -d "$HOME/.fly/bin" ]]; then
        export PATH="$HOME/.fly/bin:$PATH"
    fi

    if ! _get_fly_cmd &>/dev/null; then
        log_error "flyctl not found in PATH after installation"
        return 1
    fi

    log_info "flyctl CLI installed"
}

# Ensure FLY_API_TOKEN is available.
# Auth chain: (1) env var, (2) saved config, (3) fly auth token, (4) fly auth login (OAuth)
ensure_fly_token() {
    local fly_cmd
    fly_cmd=$(_get_fly_cmd 2>/dev/null) || fly_cmd=""

    # 1. Env var — already set by user
    if [[ -n "${FLY_API_TOKEN:-}" ]]; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
        if _test_fly_token; then
            log_info "Using Fly.io API token from environment"
            _save_token_to_config "$HOME/.config/spawn/fly.json" "$FLY_API_TOKEN"
            _fly_prompt_org
            return 0
        fi
        log_warn "FLY_API_TOKEN from environment is invalid or expired"
        unset FLY_API_TOKEN
    fi

    # 2. Saved config
    if _load_token_from_config "$HOME/.config/spawn/fly.json" "FLY_API_TOKEN" "Fly.io"; then
        FLY_API_TOKEN=$(_sanitize_fly_token "$FLY_API_TOKEN")
        export FLY_API_TOKEN
        if _test_fly_token; then
            log_info "Using saved Fly.io API token"
            _fly_prompt_org
            return 0
        fi
        log_warn "Saved Fly.io token is invalid or expired"
        unset FLY_API_TOKEN
    fi

    # 3. Try existing fly CLI session (fly auth token)
    if [[ -n "$fly_cmd" ]]; then
        local token
        token=$("$fly_cmd" auth token 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' || true)
        if [[ -n "$token" ]]; then
            FLY_API_TOKEN=$(_sanitize_fly_token "$token")
            export FLY_API_TOKEN
            if _test_fly_token; then
                log_info "Using Fly.io API token from fly CLI"
                _save_token_to_config "$HOME/.config/spawn/fly.json" "$FLY_API_TOKEN"
                _fly_prompt_org
                return 0
            fi
            log_warn "Fly CLI session token is invalid or expired"
            unset FLY_API_TOKEN
        fi
    fi

    # 4. OAuth login via fly auth login
    if [[ -n "$fly_cmd" ]]; then
        log_step "Launching Fly.io OAuth login..."
        if "$fly_cmd" auth login 2>&1; then
            local token
            token=$("$fly_cmd" auth token 2>/dev/null | head -1 | sed 's/\x1b\[[0-9;]*m//g' || true)
            if [[ -n "$token" ]]; then
                FLY_API_TOKEN=$(_sanitize_fly_token "$token")
                export FLY_API_TOKEN
                _save_token_to_config "$HOME/.config/spawn/fly.json" "$FLY_API_TOKEN"
                log_info "Authenticated with Fly.io via OAuth"
                _fly_prompt_org
                return 0
            fi
        fi
        log_warn "fly auth login did not succeed"
    else
        log_warn "fly CLI not installed — skipping OAuth login"
    fi

    # 5. Last resort — manual token paste
    log_step "Manual token entry (last resort)"
    log_warn "Get a token from: https://fly.io/dashboard → Tokens"
    local token
    token=$(validated_read "Enter your Fly.io API token: " validate_api_token) || return 1
    FLY_API_TOKEN=$(_sanitize_fly_token "$token")
    export FLY_API_TOKEN
    if ! _test_fly_token; then
        log_error "Token is invalid"
        unset FLY_API_TOKEN
        return 1
    fi
    _save_token_to_config "$HOME/.config/spawn/fly.json" "$FLY_API_TOKEN"
    log_info "Using manually entered Fly.io API token"
    _fly_prompt_org
}

# Parse fly CLI / GraphQL org JSON into pipe-delimited "slug|name" lines.
# On failure, prints diagnostic info to stderr and returns 1.
_fly_parse_orgs_json() {
    local input
    input=$(cat)
    local parse_stderr
    parse_stderr=$(mktemp)
    local result
    result=$(printf '%s' "$input" | bun -e '
const data = JSON.parse(await Bun.stdin.text());
if (typeof data === "object" && !Array.isArray(data) && !("nodes" in data) && !("organizations" in data)) {
    if (!Object.keys(data).length) { console.error("JSON object has no keys"); process.exit(1); }
    for (const [slug, name] of Object.entries(data)) console.log(slug + "|" + String(name));
} else {
    const orgs: any[] = Array.isArray(data) ? data : ((data as any).nodes ?? (data as any).organizations ?? []);
    if (!orgs.length) { console.error("No organizations found in response"); process.exit(1); }
    for (const o of orgs) {
        const slug = o.slug || o.name || "";
        const name = o.name || slug;
        const suffix = o.type ? " (" + o.type + ")" : "";
        if (slug) console.log(slug + "|" + name + suffix);
    }
}
' 2>"$parse_stderr") || {
        local parse_err
        parse_err=$(cat "$parse_stderr" 2>/dev/null)
        rm -f "$parse_stderr"
        printf 'Failed to parse org JSON\n' >&2
        if [[ -n "$parse_err" ]]; then
            printf 'parse error: %s\n' "$parse_err" >&2
        fi
        printf 'raw JSON (first 500 chars): %.500s\n' "$input" >&2
        return 1
    }
    rm -f "$parse_stderr"
    if [[ -z "$result" ]]; then
        printf 'Parsed org list is empty (JSON had data but no valid orgs)\n' >&2
        printf 'raw JSON (first 500 chars): %.500s\n' "$input" >&2
        return 1
    fi
    printf '%s\n' "$result"
}

# List Fly.io organizations — tries fly CLI first, falls back to GraphQL API.
# Emits pipe-delimited "slug|name" lines on stdout.
# On failure, prints diagnostic info to stderr and returns 1.
_fly_list_orgs() {
    local fly_cmd json cli_err=""

    # 1. Try fly CLI
    fly_cmd=$(_get_fly_cmd 2>/dev/null) || fly_cmd=""
    if [[ -n "$fly_cmd" ]]; then
        local cli_stderr
        cli_stderr=$("$fly_cmd" orgs list --json 2>&1 1>/dev/null) || true
        json=$("$fly_cmd" orgs list --json 2>/dev/null) || json=""
        if [[ -n "$json" ]]; then
            local result parse_diag
            parse_diag=$(mktemp)
            result=$(printf '%s' "$json" | _fly_parse_orgs_json 2>"$parse_diag") || result=""
            if [[ -n "$result" ]]; then
                rm -f "$parse_diag"
                printf '%s\n' "$result"
                return 0
            fi
            cli_err="fly orgs list --json returned data but parsing failed"
            local pd
            pd=$(cat "$parse_diag" 2>/dev/null)
            rm -f "$parse_diag"
            [[ -n "$pd" ]] && cli_err="${cli_err}; ${pd}"
        elif [[ -n "$cli_stderr" ]]; then
            cli_err="fly orgs list --json failed: ${cli_stderr}"
        else
            cli_err="fly orgs list --json returned empty output"
        fi
    else
        cli_err="fly CLI not found in PATH"
    fi

    # 2. Fall back to Fly.io GraphQL API (works with any token type)
    if [[ -z "${FLY_API_TOKEN:-}" ]]; then
        printf '%s\n' "$cli_err" >&2
        printf 'GraphQL fallback skipped: FLY_API_TOKEN is not set\n' >&2
        return 1
    fi

    local auth_header
    if [[ "$FLY_API_TOKEN" == FlyV1\ * ]]; then
        auth_header="$FLY_API_TOKEN"
    else
        auth_header="Bearer $FLY_API_TOKEN"
    fi

    local gql_body='{"query":"{ organizations { nodes { slug name type } } }"}'
    local gql_stderr
    gql_stderr=$(mktemp)
    json=$(curl -sS -X POST "https://api.fly.io/graphql" \
        -H "Authorization: ${auth_header}" \
        -H "Content-Type: application/json" \
        -d "$gql_body" 2>"$gql_stderr") || json=""

    if [[ -z "$json" ]]; then
        local curl_err
        curl_err=$(cat "$gql_stderr" 2>/dev/null)
        rm -f "$gql_stderr"
        printf '%s\n' "$cli_err" >&2
        printf 'GraphQL fallback also failed: curl returned empty response\n' >&2
        [[ -n "$curl_err" ]] && printf 'curl stderr: %s\n' "$curl_err" >&2
        return 1
    fi
    rm -f "$gql_stderr"

    # Extract organizations.nodes from GraphQL response
    local gql_parse_stderr
    gql_parse_stderr=$(mktemp)
    local gql_result
    gql_result=$(printf '%s' "$json" | bun -e '
const resp = JSON.parse(await Bun.stdin.text());
const errs = resp?.errors;
if (errs?.length) { console.error("GraphQL errors: " + JSON.stringify(errs)); process.exit(1); }
const nodes = resp?.data?.organizations?.nodes ?? [];
if (!nodes.length) { console.error("No organizations in GraphQL response"); process.exit(1); }
for (const o of nodes) {
    const slug = o.slug || o.name || "";
    const name = o.name || slug;
    const suffix = o.type ? " (" + o.type + ")" : "";
    if (slug) console.log(slug + "|" + name + suffix);
}
' 2>"$gql_parse_stderr") || {
        local gql_err
        gql_err=$(cat "$gql_parse_stderr" 2>/dev/null)
        rm -f "$gql_parse_stderr"
        printf '%s\n' "$cli_err" >&2
        printf 'GraphQL fallback also failed\n' >&2
        [[ -n "$gql_err" ]] && printf 'GraphQL: %s\n' "$gql_err" >&2
        printf 'raw GraphQL response (first 500 chars): %.500s\n' "$json" >&2
        return 1
    }
    rm -f "$gql_parse_stderr"

    if [[ -z "$gql_result" ]]; then
        printf '%s\n' "$cli_err" >&2
        printf 'GraphQL returned data but no valid orgs parsed\n' >&2
        printf 'raw GraphQL response (first 500 chars): %.500s\n' "$json" >&2
        return 1
    fi
    printf '%s\n' "$gql_result"
}

# Prompt user to select their Fly.io organization.
# Fails loudly if org list cannot be fetched — surfaces root cause for debugging.
_fly_prompt_org() {
    if [[ -n "${FLY_ORG:-}" || "${SPAWN_NON_INTERACTIVE:-}" == "1" ]]; then
        return 0
    fi

    log_step "Fetching available Fly.io organizations..."
    local items="" diag_output
    diag_output=$(mktemp)
    items=$(_fly_list_orgs 2>"$diag_output") || true

    if [[ -z "$items" ]]; then
        local diag
        diag=$(cat "$diag_output" 2>/dev/null)
        rm -f "$diag_output"
        log_error "Failed to fetch Fly.io organizations"
        if [[ -n "$diag" ]]; then
            log_error "Root cause: $diag"
        fi
        log_warn "Debug hints:"
        log_warn "  1. Is fly installed?     Run: fly version"
        log_warn "  2. Is your token valid?  Run: fly auth whoami"
        log_warn "  3. Can you list orgs?    Run: fly orgs list --json"
        log_warn "  4. Is bun available?     Run: bun --version"
        return 1
    fi
    rm -f "$diag_output"

    local org
    org=$(_display_and_select "Fly.io organizations" "personal" "personal" <<< "$items")
    export FLY_ORG="${org:-personal}"
    log_info "Using Fly.io org: ${FLY_ORG}"
}

# ============================================================
# Provisioning
# ============================================================

# Get server name from env var or prompt
get_server_name() {
    get_validated_server_name "FLY_APP_NAME" "Enter app name: "
}

# Create Fly.io app. Fails with clear message if name is taken.
_fly_create_app() {
    local name="$1"
    local org="${FLY_ORG:-personal}"

    log_step "Creating Fly.io app '$name'..."
    local app_body
    app_body=$(printf '{"app_name":%s,"org_slug":%s}' "$(json_escape "$name")" "$(json_escape "$org")")
    local response
    response=$(fly_api POST "/apps" "$app_body")

    if printf '%s' "$response" | grep -q '"error"'; then
        local error_msg
        error_msg=$(printf '%s' "$response" | _fly_json "error" "Unknown error")
        if printf '%s' "$error_msg" | grep -qi "already exists"; then
            log_info "App '$name' already exists, reusing it"
            return 0
        fi
        log_error "Failed to create Fly.io app: $error_msg"
        if printf '%s' "$error_msg" | grep -qi "taken\|Name.*valid"; then
            log_warn "Fly.io app names are globally unique. Set a different name with: FLY_APP_NAME=my-unique-name"
        fi
        return 1
    fi

    log_info "App '$name' created"
}

# Build JSON request body for Fly.io machine creation using bash printf + json_escape.
_fly_build_machine_body() {
    local name="$1" region="$2" vm_memory="$3"
    printf '{"name":%s,"region":%s,"config":{"image":"ubuntu:24.04","guest":{"cpu_kind":"shared","cpus":1,"memory_mb":%d},"init":{"exec":["/bin/sleep","inf"]},"auto_destroy":false}}' \
        "$(json_escape "$name")" "$(json_escape "$region")" "$vm_memory"
}

# Create a Fly.io machine via the Machines API.
# Sets FLY_MACHINE_ID and FLY_APP_NAME on success.
_fly_create_machine() {
    local name="$1"
    local region="$2"
    local vm_memory="$3"

    log_step "Creating Fly.io machine (region: $region, memory: ${vm_memory}MB)..."

    local machine_body
    machine_body=$(_fly_build_machine_body "$name" "$region" "$vm_memory")

    local response
    response=$(fly_api POST "/apps/$name/machines" "$machine_body")

    if printf '%s' "$response" | grep -q '"error"'; then
        log_error "Failed to create Fly.io machine: $(printf '%s' "$response" | _fly_json "error" "Unknown error")"
        log_warn "Check your dashboard: https://fly.io/dashboard"
        return 1
    fi

    FLY_MACHINE_ID=$(printf '%s' "$response" | _fly_json "id")
    if [[ -z "$FLY_MACHINE_ID" ]]; then
        log_error "Failed to extract machine ID from API response"
        return 1
    fi
    export FLY_MACHINE_ID FLY_APP_NAME="$name"
    log_info "Machine created: ID=$FLY_MACHINE_ID, App=$name"
}

# Wait for a Fly.io machine to reach "started" state using the /wait endpoint.
_fly_wait_for_machine_start() {
    local name="$1"
    local machine_id="$2"
    local timeout="${3:-90}"

    log_step "Waiting for machine to start (timeout: ${timeout}s)..."
    local response
    response=$(fly_api GET "/apps/$name/machines/$machine_id/wait?state=started&timeout=$timeout")

    if printf '%s' "$response" | grep -q '"error"'; then
        log_error "Machine did not reach 'started' state: $(printf '%s' "$response" | _fly_json "error" "timeout")"
        log_error "Try a new region: FLY_REGION=ord spawn fly <agent>"
        return 1
    fi
    log_info "Machine is running"
}

# Delete app on machine creation failure
_fly_cleanup_on_failure() {
    local app_name="$1"
    log_warn "Cleaning up app '$app_name' after provisioning failure..."
    fly_api DELETE "/apps/$app_name" >/dev/null 2>&1 || true
}

# Create a Fly.io app and machine
create_server() {
    local name="$1"
    local region="${FLY_REGION:-iad}"
    local vm_memory="${FLY_VM_MEMORY:-1024}"

    validate_region_name "$region" || { log_error "Invalid FLY_REGION"; return 1; }
    if [[ ! "$vm_memory" =~ ^[0-9]+$ ]]; then log_error "Invalid FLY_VM_MEMORY: must be numeric"; return 1; fi

    _fly_create_app "$name" || return 1

    if ! _fly_create_machine "$name" "$region" "$vm_memory"; then
        _fly_cleanup_on_failure "$name"
        return 1
    fi

    _fly_wait_for_machine_start "$name" "$FLY_MACHINE_ID" || return 1

    save_vm_connection "fly-ssh" "root" "${FLY_MACHINE_ID}" "$name" "fly"
}

# ============================================================
# Execution
# ============================================================

# Run a command on the Fly.io machine via `fly machine exec`.
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

    if [[ -n "${timeout_secs}" && -n "${timeout_bin}" ]]; then
        "${timeout_bin}" "${timeout_secs}" \
            "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
            -- bash -c "$full_cmd"
        return $?
    fi
    "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
        -- bash -c "$full_cmd"
}

# Upload a file to the machine via stdin pipe through `fly machine exec`.
upload_file() {
    local local_path="$1"
    local remote_path="$2"

    if [[ ! "${remote_path}" =~ ^[a-zA-Z0-9/_.~-]+$ ]]; then
        log_error "Invalid remote path (must contain only alphanumeric, /, _, ., ~, -): ${remote_path}"
        return 1
    fi

    local fly_cmd
    fly_cmd=$(_get_fly_cmd)

    "$fly_cmd" machine exec "$FLY_MACHINE_ID" --app "$FLY_APP_NAME" \
        -- bash -c "cat > $(printf '%q' "$remote_path")" \
        < "$local_path"
}

# Start an interactive SSH session on the Fly.io machine.
# Uses fly ssh console --pty for proper TTY allocation.
interactive_session() {
    local cmd="$1"
    local full_cmd="export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\" && $cmd"
    local escaped_cmd
    escaped_cmd=$(printf '%q' "$full_cmd")
    local session_exit=0
    "$(_get_fly_cmd)" ssh console -a "$FLY_APP_NAME" --pty -C "bash -c $escaped_cmd" || session_exit=$?
    SERVER_NAME="${FLY_APP_NAME:-}" SPAWN_RECONNECT_CMD="fly ssh console -a ${FLY_APP_NAME:-}" \
        _show_exec_post_session_summary
    return "${session_exit}"
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

    log_step "Installing packages..."
    _fly_run_with_retry 3 10 300 "apt-get update -y && apt-get install -y curl unzip git" || {
        log_warn "Package install failed, continuing anyway..."
    }
    log_step "Installing Node.js..."
    _fly_run_with_retry 3 10 180 "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs" || true
    # Verify node is actually installed — nodesource setup can succeed but leave node missing (#1581)
    if ! run_server "which node && node --version" 15 >/dev/null 2>&1; then
        log_warn "Node.js not found after nodesource install, falling back to default Debian package..."
        _fly_run_with_retry 2 5 120 "apt-get install -y nodejs" || true
        if ! run_server "which node && node --version" 15 >/dev/null 2>&1; then
            log_error "Node.js is NOT installed — npm-based agents will not work"
        else
            log_info "Node.js installed from default Debian repos: $(run_server 'node --version' 10 2>/dev/null)"
        fi
    else
        log_info "Node.js installed: $(run_server 'node --version' 10 2>/dev/null)"
    fi
    log_step "Installing bun..."
    _fly_run_with_retry 2 5 120 "curl -fsSL https://bun.sh/install | bash" || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.bashrc' 30 || true
    run_server 'echo "export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"" >> ~/.zshrc' 30 || true
    log_info "Base tools installed"
}

# ============================================================
# Lifecycle
# ============================================================

# Destroy a Fly.io machine and app
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
    machine_ids=$(printf '%s' "$machines" | _fly_json_ids)

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
    if printf '%s' "$delete_response" | grep -q '"error"'; then
        log_error "Failed to delete app '$app_name': $(printf '%s' "$delete_response" | _fly_json "error" "Unknown error")"
        return 1
    fi

    [[ "$failed" -eq 1 ]] && log_warn "Some machines may not have been fully destroyed — check: fly machines list -a $app_name"
    log_info "App '$app_name' destroyed"
}

# List all Fly.io apps
list_servers() {
    local org="${FLY_ORG:-personal}"
    local response
    response=$(fly_api GET "/apps?org_slug=$org")

    printf '%s' "$response" | bun -e '
const d = JSON.parse(await Bun.stdin.text());
const apps: any[] = Array.isArray(d) ? d : (d.apps ?? []);
if (!apps.length) { console.log("No apps found"); process.exit(0); }
const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
console.log(pad("NAME",25) + pad("ID",20) + pad("STATUS",12) + pad("NETWORK",20));
console.log("-".repeat(77));
for (const a of apps)
    console.log(pad((a.name??"N/A").slice(0,24),25) + pad((a.id??"N/A").slice(0,19),20) + pad((a.status??"N/A").slice(0,11),12) + pad((a.network??"N/A").slice(0,19),20));
' 2>/dev/null
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
