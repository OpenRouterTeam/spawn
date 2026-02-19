#!/bin/bash
set -eo pipefail

# E2E Tests — Real server provisioning, agent install, and verification
# By default runs ONE agent per cloud (smoke test). Use --all for the full matrix.
#
# Usage:
#   bash test/e2e.sh                    # One agent per cloud (smoke test)
#   bash test/e2e.sh --all              # All agents on all clouds (full matrix)
#   bash test/e2e.sh fly                # One agent on fly
#   bash test/e2e.sh fly openclaw       # Single combo
#   bash test/e2e.sh fly --all          # All agents on fly
#   bash test/e2e.sh --cleanup          # Destroy stale e2e-* servers
#   bash test/e2e.sh --history          # Show timing history
#   bash test/e2e.sh --compare openclaw # Compare agent across clouds
#
# Environment:
#   OPENROUTER_API_KEY  — Required for all tests
#   E2E_CANARY_AGENT    — Agent to use for smoke tests (default: openclaw)
#   E2E_AUTO_FIX        — Set to "1" to spawn Claude agents for failures (default: 0)
#   E2E_OPTIMIZE        — Set to "1" to spawn Claude agents for slow-but-passing tests (default: 0)
#   E2E_TIMEOUT         — Per-combo timeout in seconds (default: 900)
#
# Each agent script runs with SPAWN_NON_INTERACTIVE=1 so safe_read() fails
# immediately instead of hanging on /dev/tty.  Cloud-specific env vars
# (HETZNER_LOCATION, FLY_REGION, etc.) are auto-set to sane defaults.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_TIMEOUT="${E2E_TIMEOUT:-900}"
E2E_AUTO_FIX="${E2E_AUTO_FIX:-0}"
E2E_OPTIMIZE="${E2E_OPTIMIZE:-0}"
E2E_ALL=0
E2E_CANARY_AGENT="${E2E_CANARY_AGENT:-openclaw}"
E2E_RESULTS_DIR=""
E2E_SERVER_PREFIX="e2e"
E2E_PIDS=""
E2E_TIMINGS_FILE="${REPO_ROOT}/.docs/e2e-timings.json"
E2E_SLOW_THRESHOLD=180  # seconds — flag as slow even if passing

# --- Logging ---

_e2e_log() {
    printf '[%s] [e2e] %s\n' "$(date +'%H:%M:%S')" "$*"
}

_e2e_pass() {
    printf '  \033[32m✓\033[0m %s\n' "$*"
}

_e2e_fail() {
    printf '  \033[31m✗\033[0m %s\n' "$*"
}

# --- Cloud config lookup (bash 3.2 compatible — no associative arrays) ---

# Get the env var name used for server/app name
_get_name_env_var() {
    case "$1" in
        fly)          echo "FLY_APP_NAME" ;;
        hetzner)      echo "HETZNER_SERVER_NAME" ;;
        digitalocean) echo "DO_DROPLET_NAME" ;;
        aws)          echo "LIGHTSAIL_SERVER_NAME" ;;
        daytona)      echo "DAYTONA_SANDBOX_NAME" ;;
        gcp)          echo "GCP_INSTANCE_NAME" ;;

        sprite)       echo "SPRITE_NAME" ;;
        *)            echo "" ;;
    esac
}

# Get the env var name used for cloud token
_get_token_env_var() {
    case "$1" in
        fly)          echo "FLY_API_TOKEN" ;;
        hetzner)      echo "HCLOUD_TOKEN" ;;
        digitalocean) echo "DO_API_TOKEN" ;;
        daytona)      echo "DAYTONA_API_KEY" ;;
        *)            echo "" ;;
    esac
}

# --- Credential helpers ---

# Try to load a token from the spawn config file into the env var.
# Returns 0 if token was loaded, 1 if not.
_load_token_from_config() {
    local cloud="$1"
    local token_var
    token_var=$(_get_token_env_var "$cloud")
    [[ -z "$token_var" ]] && return 1

    # Already set — nothing to do
    local current="${!token_var:-}"
    [[ -n "$current" ]] && return 0

    local config_file="${HOME}/.config/spawn/${cloud}.json"
    [[ -f "$config_file" ]] || return 1

    local saved
    saved=$(python3 -c "import json, sys; data=json.load(open(sys.argv[1])); print(data.get('api_key','') or data.get('token',''))" "$config_file" 2>/dev/null)
    if [[ -n "$saved" ]]; then
        export "$token_var=$saved"
        return 0
    fi
    return 1
}

# Interactive credential collection — runs BEFORE non-interactive tests.
# For each token-based cloud, ensures the env var is set by:
#   1. Checking the env var
#   2. Loading from ~/.config/spawn/{cloud}.json
#   3. Prompting the user (Enter to skip)
_collect_credentials() {
    local clouds="$1"
    local collected=""
    local skipped=""

    for cloud in $clouds; do
        local token_var
        token_var=$(_get_token_env_var "$cloud")

        # CLI-auth clouds (aws, gcp, sprite) — no token to collect
        [[ -z "$token_var" ]] && continue

        # Already in env?
        if [[ -n "${!token_var:-}" ]]; then
            collected="${collected} ${cloud}"
            continue
        fi

        # Try config file
        if _load_token_from_config "$cloud"; then
            _e2e_log "Loaded ${token_var} from ~/.config/spawn/${cloud}.json"
            collected="${collected} ${cloud}"
            continue
        fi

        # Fly: try CLI auth (fly auth token)
        if [[ "$cloud" == "fly" ]] && _try_fly_cli_token; then
            _e2e_log "Loaded FLY_API_TOKEN from fly CLI auth"
            collected="${collected} ${cloud}"
            continue
        fi

        # No TTY? Can't prompt — skip
        if ! echo -n "" > /dev/tty 2>/dev/null; then
            skipped="${skipped} ${cloud}"
            continue
        fi

        # Interactive prompt
        printf '  %s: paste %s (Enter to skip): ' "$cloud" "$token_var"
        local token=""
        read -r token </dev/tty
        if [[ -n "$token" ]]; then
            export "$token_var=$token"
            collected="${collected} ${cloud}"
        else
            skipped="${skipped} ${cloud}"
        fi
    done

    if [[ -n "$skipped" ]]; then
        _e2e_log "Skipped (no credentials):${skipped}"
    fi
}

# Try to get FLY_API_TOKEN from the flyctl CLI (fly auth token)
_try_fly_cli_token() {
    local fly_cmd=""
    if command -v fly &>/dev/null; then
        fly_cmd="fly"
    elif command -v flyctl &>/dev/null; then
        fly_cmd="flyctl"
    else
        return 1
    fi
    local token
    token=$("$fly_cmd" auth token 2>/dev/null) || return 1
    if [[ -n "$token" ]]; then
        export FLY_API_TOKEN="$token"
        return 0
    fi
    return 1
}

# --- Credential check ---

# Check if a cloud has credentials available (non-interactive)
_cloud_has_credentials() {
    local cloud="$1"
    local token_var
    token_var=$(_get_token_env_var "$cloud")

    # Clouds that use CLI auth rather than env var tokens
    case "$cloud" in
        aws)    command -v aws &>/dev/null && aws sts get-caller-identity &>/dev/null 2>&1; return $? ;;
        gcp)    command -v gcloud &>/dev/null && gcloud auth print-access-token &>/dev/null 2>&1; return $? ;;

        sprite) command -v sprite &>/dev/null; return $? ;;
        local)  return 0 ;;
    esac

    # Token-based clouds: check env var, then spawn config file, then CLI
    if [[ -n "$token_var" ]]; then
        local token_val="${!token_var:-}"
        if [[ -n "$token_val" ]]; then
            return 0
        fi
        # Check spawn config file
        local config_file="${HOME}/.config/spawn/${cloud}.json"
        if [[ -f "$config_file" ]]; then
            return 0
        fi
        # Fly: also check CLI auth
        if [[ "$cloud" == "fly" ]]; then
            _try_fly_cli_token &>/dev/null && return 0
        fi
    fi
    return 1
}

# --- Cleanup ---

_cleanup_e2e() {
    local exit_code=$?
    # Kill any remaining background test jobs
    if [[ -n "${E2E_PIDS:-}" ]]; then
        for pid in ${E2E_PIDS}; do
            kill "$pid" 2>/dev/null || true
        done
    fi
    # Clean up results dir
    if [[ -n "${E2E_RESULTS_DIR:-}" ]] && [[ -d "${E2E_RESULTS_DIR}" ]]; then
        rm -rf "${E2E_RESULTS_DIR}"
    fi
    exit "$exit_code"
}
trap _cleanup_e2e EXIT SIGTERM SIGINT

# --- macOS-compatible timeout ---

_run_with_timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    local elapsed=0
    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$elapsed" -ge "$secs" ]]; then
            kill "$pid" 2>/dev/null
            sleep 1
            kill -9 "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    wait "$pid" 2>/dev/null
}

# --- Stale server cleanup ---

_cleanup_stale_servers() {
    local cloud="$1"
    _e2e_log "Cleaning up stale ${E2E_SERVER_PREFIX}-* servers on ${cloud}..."

    case "$cloud" in
        fly)
            source "${REPO_ROOT}/fly/lib/common.sh"
            local org
            org=$(get_fly_org 2>/dev/null) || return 0
            local apps_json
            apps_json=$(fly_api GET "/apps?org_slug=$org" 2>/dev/null) || return 0
            local stale_apps
            stale_apps=$(printf '%s' "$apps_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
apps = data if isinstance(data, list) else data.get('apps', [])
for a in apps:
    name = a.get('name', '')
    if name.startswith('${E2E_SERVER_PREFIX}-'):
        print(name)
" 2>/dev/null || true)
            for app in $stale_apps; do
                _e2e_log "  Destroying stale app: $app"
                destroy_server "$app" 2>/dev/null || true
            done
            ;;
        hetzner)
            source "${REPO_ROOT}/hetzner/lib/common.sh"
            local servers_json
            servers_json=$(hetzner_api GET "/servers" 2>/dev/null) || return 0
            local stale_servers
            stale_servers=$(printf '%s' "$servers_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for s in data.get('servers', []):
    name = s.get('name', '')
    sid = s.get('id', '')
    if name.startswith('${E2E_SERVER_PREFIX}-'):
        print(sid)
" 2>/dev/null || true)
            for sid in $stale_servers; do
                _e2e_log "  Destroying stale server: $sid"
                destroy_server "$sid" 2>/dev/null || true
            done
            ;;
        digitalocean)
            source "${REPO_ROOT}/digitalocean/lib/common.sh"
            local droplets_json
            droplets_json=$(do_api GET "/droplets" 2>/dev/null) || return 0
            local stale_droplets
            stale_droplets=$(printf '%s' "$droplets_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for d in data.get('droplets', []):
    name = d.get('name', '')
    did = d.get('id', '')
    if name.startswith('${E2E_SERVER_PREFIX}-'):
        print(did)
" 2>/dev/null || true)
            for did in $stale_droplets; do
                _e2e_log "  Destroying stale droplet: $did"
                destroy_server "$did" 2>/dev/null || true
            done
            ;;
    esac
}

# Destroy a specific e2e test server by name.
# Clouds that take a name directly are easy; others need a name→ID lookup.
_destroy_e2e_server() {
    local cloud="$1" server_name="$2"

    case "$cloud" in
        fly)
            source "${REPO_ROOT}/fly/lib/common.sh" 2>/dev/null || return 0
            destroy_server "$server_name" 2>/dev/null || true
            ;;
        aws)
            source "${REPO_ROOT}/aws/lib/common.sh" 2>/dev/null || return 0
            destroy_server "$server_name" 2>/dev/null || true
            ;;
        gcp)
            source "${REPO_ROOT}/gcp/lib/common.sh" 2>/dev/null || return 0
            destroy_server "$server_name" 2>/dev/null || true
            ;;
        hetzner)
            source "${REPO_ROOT}/hetzner/lib/common.sh" 2>/dev/null || return 0
            local servers_json sid
            servers_json=$(hetzner_api GET "/servers?name=${server_name}" 2>/dev/null) || return 0
            sid=$(printf '%s' "$servers_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for s in data.get('servers', []):
    if s.get('name') == '${server_name}':
        print(s['id']); break
" 2>/dev/null) || return 0
            [[ -n "$sid" ]] && destroy_server "$sid" 2>/dev/null || true
            ;;
        digitalocean)
            source "${REPO_ROOT}/digitalocean/lib/common.sh" 2>/dev/null || return 0
            local droplets_json did
            droplets_json=$(do_api GET "/droplets?tag_name=${server_name}" 2>/dev/null) || return 0
            did=$(printf '%s' "$droplets_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for d in data.get('droplets', []):
    if d.get('name') == '${server_name}':
        print(d['id']); break
" 2>/dev/null) || return 0
            [[ -n "$did" ]] && destroy_server "$did" 2>/dev/null || true
            ;;
        daytona)
            source "${REPO_ROOT}/daytona/lib/common.sh" 2>/dev/null || return 0
            destroy_server "$server_name" 2>/dev/null || true
            ;;
    esac
}

# --- Non-interactive env setup ---

# Export all env vars needed to run agent scripts without any interactive prompts.
# Called by both preflight and per-combo tests.
_setup_noninteractive_env() {
    local cloud="$1"

    export SPAWN_NON_INTERACTIVE=1
    export MODEL_ID="${MODEL_ID:-openrouter/auto}"
    export SPAWN_SKIP_GITHUB_AUTH=1

    case "$cloud" in
        hetzner)
            export HETZNER_LOCATION="${HETZNER_LOCATION:-fsn1}"
            export HETZNER_SERVER_TYPE="${HETZNER_SERVER_TYPE:-cx23}"
            ;;
        fly)
            export FLY_REGION="${FLY_REGION:-iad}"
            export FLY_VM_SIZE="${FLY_VM_SIZE:-shared-cpu-1x}"
            export FLY_VM_MEMORY="${FLY_VM_MEMORY:-1024}"
            ;;
        gcp)
            export GCP_ZONE="${GCP_ZONE:-us-central1-a}"
            export GCP_MACHINE_TYPE="${GCP_MACHINE_TYPE:-e2-micro}"
            ;;
    esac
}

# --- Per-cloud preflight ---

# Run cloud_authenticate() once per cloud BEFORE parallel agent tests.
# This installs CLIs, imports SSH keys, and validates tokens so that
# 15 parallel agent scripts don't race on the same shared resources.
_preflight_cloud() {
    local cloud="$1"
    local log_file="${E2E_RESULTS_DIR}/preflight_${cloud}.log"
    local env_file="${E2E_RESULTS_DIR}/preflight_${cloud}.env"

    _e2e_log "Pre-flight: ${cloud}..."

    # Run cloud_authenticate in a subshell, then dump the validated token
    # so the parent can export it for agent scripts.
    local token_var
    token_var=$(_get_token_env_var "$cloud")

    (
        _setup_noninteractive_env "$cloud"
        source "${REPO_ROOT}/${cloud}/lib/common.sh"
        cloud_authenticate

        # Write validated token to env file for parent to pick up
        if [[ -n "$token_var" ]] && [[ -n "${!token_var:-}" ]]; then
            printf '%s' "${!token_var}" > "$env_file"
        fi
    ) > "$log_file" 2>&1

    local rc=$?
    if [[ $rc -ne 0 ]]; then
        local last_err
        last_err=$(grep -iE "error|fail|cannot|not found|invalid" "$log_file" 2>/dev/null | tail -1 || true)
        _e2e_fail "pre-flight ${cloud}: ${last_err:-exit code $rc}"
        return 1
    fi

    # Import validated token into parent so agent scripts skip re-validation
    if [[ -n "$token_var" ]] && [[ -f "$env_file" ]] && [[ -s "$env_file" ]]; then
        local token_val
        token_val=$(cat "$env_file")
        export "$token_var=$token_val"
        rm -f "$env_file"
    fi

    _e2e_pass "pre-flight ${cloud}"
    return 0
}

# --- Per-combo test function ---

run_e2e_test() {
    local cloud="$1" agent="$2"
    local server_name="${E2E_SERVER_PREFIX}-${agent}-$(date +%s)-$$"
    local log_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.log"
    local start_time
    start_time=$(date +%s)

    _e2e_log "  ▶ ${cloud}/${agent} starting..."

    # Set the cloud-specific server name env var so the script skips interactive prompt
    local name_var
    name_var=$(_get_name_env_var "$cloud")
    if [[ -n "$name_var" ]]; then
        export "$name_var"="$server_name"
    fi

    _setup_noninteractive_env "$cloud"

    # Run the agent script with stdin from /dev/null (no interactive prompts)
    local exit_code=0
    _run_with_timeout "$E2E_TIMEOUT" bash "${REPO_ROOT}/${cloud}/${agent}.sh" \
        < /dev/null > "$log_file" 2>&1 || exit_code=$?

    local elapsed=$(( $(date +%s) - start_time ))

    # Determine result
    # The script will always "fail" at the interactive session step (no TTY),
    # but "setup completed successfully" printed before that means everything
    # up to session launch worked.
    local result="fail"
    local reason=""

    if [[ "$exit_code" -eq 124 ]]; then
        reason="timeout (${E2E_TIMEOUT}s)"
    elif grep -q "setup completed successfully" "$log_file" 2>/dev/null; then
        result="pass"
        reason="setup complete (session expected to fail without TTY)"
    else
        reason="exit code ${exit_code}"
        # Try to extract last meaningful error
        local last_error
        last_error=$(grep -iE "error|fail|fatal|cannot|not found" "$log_file" 2>/dev/null | tail -3 || true)
        if [[ -n "$last_error" ]]; then
            reason="${reason}: $(printf '%s' "$last_error" | head -1)"
        fi
    fi

    # Write results
    printf '%s\n' "$result" > "${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
    printf '%s\n' "$elapsed" > "${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
    printf '%s\n' "$reason" > "${E2E_RESULTS_DIR}/${cloud}_${agent}.reason"

    # Destroy the test server — don't leak cloud resources
    _destroy_e2e_server "$cloud" "$server_name"

    # Progress output
    if [[ "$result" == "pass" ]]; then
        _e2e_pass "${cloud}/${agent}  ${elapsed}s"
    else
        _e2e_fail "${cloud}/${agent}  ${elapsed}s  (${reason})"
    fi
}

# --- Auto-fix function ---

_find_working_reference() {
    local agent="$1" exclude_cloud="$2"
    for cloud_dir in "${REPO_ROOT}"/*/; do
        local cloud_name
        cloud_name=$(basename "$cloud_dir")
        [[ "$cloud_name" == "$exclude_cloud" ]] && continue
        [[ -f "${cloud_dir}${agent}.sh" ]] || continue
        printf '%s' "${cloud_dir}${agent}.sh"
        return 0
    done
    return 1
}

# Build the prompt for a single failing combo (used by per-cloud agent)
_build_failure_context() {
    local cloud="$1" agent="$2"
    local log_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.log"
    local script="${REPO_ROOT}/${cloud}/${agent}.sh"

    printf '### %s/%s\n\n' "$cloud" "$agent"

    printf 'Last 50 lines of output:\n```\n'
    if [[ -f "$log_file" ]]; then
        tail -50 "$log_file"
    else
        printf '(no log file)\n'
    fi
    printf '```\n\n'

    printf 'Script (%s/%s.sh):\n```bash\n' "$cloud" "$agent"
    if [[ -f "$script" ]]; then
        cat "$script"
    fi
    printf '```\n\n'

    local ref_script=""
    ref_script=$(_find_working_reference "$agent" "$cloud" 2>/dev/null) || true
    if [[ -n "$ref_script" ]] && [[ -f "$ref_script" ]]; then
        printf 'Reference (working on another cloud — %s):\n```bash\n' "$(basename "$(dirname "$ref_script")")"
        cat "$ref_script"
        printf '```\n\n'
    fi
}

# Spawn one Claude agent to fix a single failing combo
auto_fix_combo() {
    local cloud="$1" agent="$2"

    if ! command -v claude &>/dev/null; then
        _e2e_log "claude CLI not found — skipping auto-fix for ${cloud}/${agent}"
        return 1
    fi

    local prompt
    prompt=$(_build_failure_context "$cloud" "$agent")

    local cloud_lib=""
    if [[ -f "${REPO_ROOT}/${cloud}/lib/common.sh" ]]; then
        cloud_lib=$(cat "${REPO_ROOT}/${cloud}/lib/common.sh")
    fi

    _e2e_log "Spawning Claude agent for ${cloud}/${agent}..."

    claude -p "You are fixing an E2E test failure for **${cloud}/${agent}**.

## Cloud Library (${cloud}/lib/common.sh)
\`\`\`bash
${cloud_lib}
\`\`\`

## Failure

${prompt}

## Instructions

Fix the failing script: ${cloud}/${agent}.sh

1. Read the error output to understand what went wrong
2. Compare with the reference script (working on another cloud) if available
3. Fix the issue — common problems: wrong install command, missing PATH, timeout in non-TTY
4. Run \`bash -n\` on every modified file

Only modify files under ${cloud}/. Do not modify lib/common.sh or shared/." 2>&1 | tee -a "${E2E_RESULTS_DIR}/autofix_${cloud}_${agent}.log" || true
}

# --- Timing history ---

# Save a test result to the timings JSON file
# Usage: _save_timing cloud/agent elapsed status
_save_timing() {
    local combo="$1" elapsed="$2" status="$3"
    local today
    today=$(date +%Y-%m-%d)

    mkdir -p "$(dirname "$E2E_TIMINGS_FILE")"

    python3 -c "
import json, sys, os

combo = sys.argv[1]
elapsed = int(sys.argv[2])
status = sys.argv[3]
today = sys.argv[4]
path = sys.argv[5]

data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        data = {}

if combo not in data:
    data[combo] = {'runs': [], 'best': {}}

entry = {'date': today, 'total': elapsed, 'status': status}
data[combo]['runs'].insert(0, entry)
# Keep last 10 runs
data[combo]['runs'] = data[combo]['runs'][:10]

# Update best if this is a pass and faster
if status == 'pass':
    best = data[combo].get('best', {})
    if not best.get('total') or elapsed < best['total']:
        data[combo]['best'] = {'total': elapsed, 'date': today}

with open(path, 'w') as f:
    json.dump(data, f, indent=2)
" "$combo" "$elapsed" "$status" "$today" "$E2E_TIMINGS_FILE" 2>/dev/null || true
}

# Show timing history from the JSON file
_show_history() {
    if [[ ! -f "$E2E_TIMINGS_FILE" ]]; then
        _e2e_log "No timing history found at ${E2E_TIMINGS_FILE}"
        return 0
    fi

    python3 -c "
import json, sys

path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

if not data:
    print('No timing data recorded yet.')
    sys.exit(0)

for combo in sorted(data.keys()):
    info = data[combo]
    best = info.get('best', {})
    best_total = best.get('total', '-')
    best_date = best.get('date', '-')
    runs = info.get('runs', [])
    print(f'\\n━━━ {combo} ━━━')
    print(f'  Best: {best_total}s ({best_date})')
    print(f'  Recent runs:')
    for r in runs[:5]:
        status_icon = '✓' if r['status'] == 'pass' else '✗'
        print(f'    {status_icon} {r[\"date\"]}  {r[\"total\"]}s  ({r[\"status\"]})')
" "$E2E_TIMINGS_FILE"
}

# Compare a single agent across all clouds
_show_compare() {
    local agent="$1"
    if [[ ! -f "$E2E_TIMINGS_FILE" ]]; then
        _e2e_log "No timing history found at ${E2E_TIMINGS_FILE}"
        return 0
    fi

    python3 -c "
import json, sys

agent = sys.argv[1]
path = sys.argv[2]
with open(path) as f:
    data = json.load(f)

matches = {k: v for k, v in data.items() if k.endswith('/' + agent)}
if not matches:
    print(f'No timing data for agent: {agent}')
    sys.exit(0)

print(f'\\n━━━ {agent} across clouds ━━━')
print(f'{\"CLOUD\":<15} {\"BEST\":<10} {\"LATEST\":<10} {\"STATUS\":<8}')
print('-' * 45)

for combo in sorted(matches.keys()):
    cloud = combo.split('/')[0]
    info = matches[combo]
    best = info.get('best', {}).get('total', '-')
    runs = info.get('runs', [])
    if runs:
        latest = runs[0]['total']
        status = runs[0]['status']
    else:
        latest = '-'
        status = '-'
    best_s = f'{best}s' if isinstance(best, int) else best
    latest_s = f'{latest}s' if isinstance(latest, int) else latest
    print(f'{cloud:<15} {best_s:<10} {latest_s:<10} {status:<8}')
" "$agent" "$E2E_TIMINGS_FILE"
}

# Check if a passing combo is slow and needs optimization
# Returns 0 (true) if optimization is needed, 1 if not
# Prints the reason to stdout
_check_slow() {
    local combo="$1" elapsed="$2"

    python3 -c "
import json, sys, os

combo = sys.argv[1]
elapsed = int(sys.argv[2])
threshold = int(sys.argv[3])
path = sys.argv[4]
agent = combo.split('/')[1]
cloud = combo.split('/')[0]

reasons = []

# Trigger 1: Absolute slow
if elapsed > threshold:
    reasons.append(f'absolute_slow: {elapsed}s exceeds {threshold}s threshold')

# Load history for regression + peer comparison
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass

# Trigger 2: Regression vs best
if combo in data:
    best = data[combo].get('best', {}).get('total')
    if best and elapsed > best * 1.5:
        reasons.append(f'regression: {elapsed}s is >50%% slower than best {best}s')

# Trigger 3: Slow vs peers (same agent on other clouds)
peer_times = []
for key, val in data.items():
    if key.endswith('/' + agent) and key != combo:
        peer_best = val.get('best', {}).get('total')
        if peer_best:
            peer_times.append((key.split('/')[0], peer_best))

if peer_times:
    fastest_cloud, fastest_time = min(peer_times, key=lambda x: x[1])
    if elapsed > fastest_time * 2:
        reasons.append(f'slow_vs_peers: {elapsed}s is >2x slower than {fastest_cloud} ({fastest_time}s)')

if reasons:
    print('|'.join(reasons))
    sys.exit(0)
else:
    sys.exit(1)
" "$combo" "$elapsed" "$E2E_SLOW_THRESHOLD" "$E2E_TIMINGS_FILE" 2>/dev/null
}

# Build context for optimization agent (peer timings, history)
_build_optimization_context() {
    local combo="$1" elapsed="$2"

    python3 -c "
import json, sys, os

combo = sys.argv[1]
elapsed = int(sys.argv[2])
path = sys.argv[3]
agent = combo.split('/')[1]
cloud = combo.split('/')[0]

data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass

lines = []

# Best time
best = '-'
if combo in data:
    b = data[combo].get('best', {}).get('total')
    if b:
        best = f'{b}s'
lines.append(f'- Total time: {elapsed}s (best ever: {best})')

# Peer timings
lines.append(f'- Same agent on other clouds:')
for key in sorted(data.keys()):
    if key.endswith('/' + agent) and key != combo:
        peer_cloud = key.split('/')[0]
        peer_best = data[key].get('best', {}).get('total', '?')
        lines.append(f'  - {peer_cloud}: {peer_best}s')

# History
if combo in data:
    runs = data[combo].get('runs', [])
    if runs:
        lines.append(f'- History:')
        for r in runs[:5]:
            lines.append(f'  - {r[\"date\"]}: {r[\"total\"]}s ({r[\"status\"]})')

print('\\n'.join(lines))
" "$combo" "$elapsed" "$E2E_TIMINGS_FILE" 2>/dev/null || true
}

# Build optimization context for a single slow combo (used by per-cloud agent)
_build_slow_context() {
    local cloud="$1" agent="$2" elapsed="$3" reasons="$4"
    local script="${REPO_ROOT}/${cloud}/${agent}.sh"

    printf '### %s/%s (%ss)\n\n' "$cloud" "$agent" "$elapsed"

    printf 'Why flagged:\n'
    printf '%s\n' "$reasons" | while IFS= read -r r; do
        printf '- %s\n' "$r"
    done
    printf '\n'

    local timing_context
    timing_context=$(_build_optimization_context "${cloud}/${agent}" "$elapsed")
    printf 'Timings:\n%s\n\n' "$timing_context"

    printf 'Script (%s/%s.sh):\n```bash\n' "$cloud" "$agent"
    if [[ -f "$script" ]]; then
        cat "$script"
    fi
    printf '```\n\n'

    local ref_script=""
    ref_script=$(_find_working_reference "$agent" "$cloud" 2>/dev/null) || true
    if [[ -n "$ref_script" ]] && [[ -f "$ref_script" ]]; then
        printf 'Reference (fastest peer — %s):\n```bash\n' "$(basename "$(dirname "$ref_script")")"
        cat "$ref_script"
        printf '```\n\n'
    fi
}

# Spawn one Claude agent to optimize a single slow combo
optimize_slow_combo() {
    local cloud="$1" agent="$2" elapsed="$3" reasons="$4"

    if ! command -v claude &>/dev/null; then
        _e2e_log "claude CLI not found — skipping optimization for ${cloud}/${agent}"
        return 1
    fi

    local prompt
    prompt=$(_build_slow_context "$cloud" "$agent" "$elapsed" "$reasons")

    local cloud_lib=""
    if [[ -f "${REPO_ROOT}/${cloud}/lib/common.sh" ]]; then
        cloud_lib=$(cat "${REPO_ROOT}/${cloud}/lib/common.sh")
    fi

    _e2e_log "Spawning Claude agent for ${cloud}/${agent} (${elapsed}s)..."

    claude -p "You are optimizing a slow E2E test for **${cloud}/${agent}**.
The script PASSES but is too slow.

## Cloud Library (${cloud}/lib/common.sh)
\`\`\`bash
${cloud_lib}
\`\`\`

## Slow Script

${prompt}

## Instructions

Optimize the script: ${cloud}/${agent}.sh

1. Compare timings with the fastest peer cloud for the same agent
2. Identify what makes it slow (heavy installer, compiling native deps, unnecessary steps)
3. Make it faster — use lighter install methods, skip unnecessary setup, parallelize where possible
4. Run \`bash -n\` on every modified file
5. Don't break anything — the script must still pass E2E

Only modify files under ${cloud}/. Do not modify lib/common.sh or shared/." 2>&1 | tee -a "${E2E_RESULTS_DIR}/optimize_${cloud}_${agent}.log" || true
}

# --- Main ---

main() {
    local filter_cloud="" filter_agent=""

    # Parse args: strip --all flag, assign positional cloud/agent
    for arg in "$@"; do
        case "$arg" in
            --all) E2E_ALL=1 ;;
            *)
                if [[ -z "$filter_cloud" ]]; then
                    filter_cloud="$arg"
                else
                    filter_agent="$arg"
                fi
                ;;
        esac
    done

    # Handle --cleanup
    if [[ "$filter_cloud" == "--cleanup" ]]; then
        _e2e_log "Running stale server cleanup..."
        for cloud in fly hetzner digitalocean; do
            if _cloud_has_credentials "$cloud"; then
                _cleanup_stale_servers "$cloud"
            fi
        done
        _e2e_log "Cleanup complete"
        return 0
    fi

    # Handle --history
    if [[ "$filter_cloud" == "--history" ]]; then
        _show_history
        return 0
    fi

    # Handle --compare AGENT
    if [[ "$filter_cloud" == "--compare" ]]; then
        if [[ -z "$filter_agent" ]]; then
            _e2e_log "Usage: bash test/e2e.sh --compare AGENT_NAME"
            return 1
        fi
        _show_compare "$filter_agent"
        return 0
    fi

    # Get OPENROUTER_API_KEY
    if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
        # Non-interactive: fail fast with a clear message
        if ! echo -n "" > /dev/tty 2>/dev/null; then
            _e2e_log "ERROR: OPENROUTER_API_KEY not set and no TTY available"
            _e2e_log "Export it before running:  export OPENROUTER_API_KEY=sk-or-v1-..."
            return 1
        fi

        # Interactive: offer OAuth or paste
        source "${REPO_ROOT}/shared/common.sh" 2>/dev/null || true

        _e2e_log "OPENROUTER_API_KEY not set — let's grab one"
        echo ""
        printf '  1) Open browser (OAuth)  — quickest, logs you in via openrouter.ai\n'
        printf '  2) Paste a key           — get one from https://openrouter.ai/settings/keys\n'
        printf '  3) Quit\n'
        echo ""
        printf '  Pick [1/2/3]: '
        read -r _choice </dev/tty

        case "${_choice}" in
            1)
                _e2e_log "Starting OAuth flow..."
                OPENROUTER_API_KEY=$(try_oauth_flow 5180) || {
                    _e2e_log "OAuth failed — falling back to manual paste"
                    printf '  Paste your API key: '
                    read -r OPENROUTER_API_KEY </dev/tty
                }
                ;;
            2)
                printf '  Paste your API key: '
                read -r OPENROUTER_API_KEY </dev/tty
                ;;
            *)
                _e2e_log "Aborted."
                return 1
                ;;
        esac

        if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
            _e2e_log "ERROR: No API key provided"
            return 1
        fi
        export OPENROUTER_API_KEY
        _e2e_log "API key set — continuing"
    fi

    # Create results directory
    E2E_RESULTS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/e2e-results-XXXXXX")

    # Testable clouds (excludes local, sprite which don't provision real servers the same way)
    local testable_clouds="fly hetzner digitalocean aws daytona gcp"

    # --- Credential collection (interactive) ---
    # Load tokens from config files and prompt for any missing ones
    # BEFORE we go non-interactive. This lets the user provide tokens
    # that aren't in env vars or config files.
    echo ""
    _e2e_log "━━━ Credential Collection ━━━"
    echo ""
    _collect_credentials "$testable_clouds"
    echo ""

    # Discover clouds with available credentials
    local available_clouds=""
    if [[ -n "$filter_cloud" ]]; then
        if _cloud_has_credentials "$filter_cloud"; then
            available_clouds="$filter_cloud"
        else
            _e2e_log "ERROR: No credentials found for ${filter_cloud}"
            _e2e_log "Set the appropriate token env var or configure via the cloud's CLI"
            return 1
        fi
    else
        for cloud in $testable_clouds; do
            if _cloud_has_credentials "$cloud"; then
                available_clouds="${available_clouds} ${cloud}"
            fi
        done
        available_clouds=$(printf '%s' "$available_clouds" | sed 's/^ //')
    fi

    if [[ -z "$available_clouds" ]]; then
        _e2e_log "No cloud credentials available. Set token env vars for at least one cloud."
        _e2e_log "Supported clouds: ${testable_clouds}"
        return 1
    fi

    _e2e_log "Available clouds: ${available_clouds}"

    # --- Pre-flight: validate each cloud once ---
    # Installs CLIs, imports SSH keys, validates tokens sequentially so that
    # the parallel agent tests don't race on shared resources.
    echo ""
    _e2e_log "━━━ Pre-flight ━━━"
    echo ""
    local ready_clouds=""
    local preflight_skipped=""
    for cloud in $available_clouds; do
        if _preflight_cloud "$cloud"; then
            ready_clouds="${ready_clouds} ${cloud}"
        else
            preflight_skipped="${preflight_skipped} ${cloud}"
        fi
    done
    ready_clouds=$(printf '%s' "$ready_clouds" | sed 's/^ //')

    if [[ -n "$preflight_skipped" ]]; then
        echo ""
        _e2e_log "Skipped clouds (pre-flight failed):${preflight_skipped}"
        _e2e_log "Check logs in ${E2E_RESULTS_DIR}/preflight_*.log"
    fi

    if [[ -z "$ready_clouds" ]]; then
        _e2e_log "All clouds failed pre-flight. Check credentials and CLIs."
        return 1
    fi

    # Collect combos for clouds that passed pre-flight.
    # Default: one canary agent per cloud.  --all or explicit agent: full set.
    local combos=""
    local combo_count=0
    for cloud in $ready_clouds; do
        if [[ -n "$filter_agent" ]]; then
            # Explicit agent requested
            if [[ -f "${REPO_ROOT}/${cloud}/${filter_agent}.sh" ]]; then
                combos="${combos} ${cloud}/${filter_agent}"
                combo_count=$((combo_count + 1))
            fi
        elif [[ "$E2E_ALL" == "1" ]]; then
            # --all: every agent on this cloud
            for script in "${REPO_ROOT}/${cloud}"/*.sh; do
                [[ -f "$script" ]] || continue
                local agent
                agent=$(basename "$script" .sh)
                [[ "$agent" == "lib" ]] && continue
                combos="${combos} ${cloud}/${agent}"
                combo_count=$((combo_count + 1))
            done
        else
            # Smoke test: one canary agent per cloud
            local canary="${E2E_CANARY_AGENT}"
            if [[ ! -f "${REPO_ROOT}/${cloud}/${canary}.sh" ]]; then
                # Canary not available on this cloud — pick the first agent
                canary=""
                for script in "${REPO_ROOT}/${cloud}"/*.sh; do
                    [[ -f "$script" ]] || continue
                    local a
                    a=$(basename "$script" .sh)
                    [[ "$a" == "lib" ]] && continue
                    canary="$a"
                    break
                done
            fi
            if [[ -n "$canary" ]]; then
                combos="${combos} ${cloud}/${canary}"
                combo_count=$((combo_count + 1))
            fi
        fi
    done
    combos=$(printf '%s' "$combos" | sed 's/^ //')

    if [[ -z "$combos" ]]; then
        _e2e_log "No test combos found for ready clouds: ${ready_clouds}"
        return 1
    fi

    local mode_label="smoke test"
    [[ "$E2E_ALL" == "1" ]] && mode_label="full matrix"
    [[ -n "$filter_agent" ]] && mode_label="filtered"
    _e2e_log "Testing ${combo_count} combo(s) [${mode_label}]: ${combos}"
    echo ""

    # Pre-cleanup: destroy stale e2e-* servers
    for cloud in $ready_clouds; do
        _cleanup_stale_servers "$cloud" 2>/dev/null || true
    done

    # Run all combos in parallel (background subshells)
    E2E_PIDS=""
    for combo in $combos; do
        local cloud="${combo%%/*}"
        local agent="${combo##*/}"
        (
            run_e2e_test "$cloud" "$agent"
        ) &
        E2E_PIDS="${E2E_PIDS} $!"
    done

    # Wait for all to finish
    _e2e_log "Waiting for ${combo_count} test(s) to complete (timeout: ${E2E_TIMEOUT}s each)..."
    for pid in ${E2E_PIDS}; do
        wait "$pid" 2>/dev/null || true
    done
    E2E_PIDS=""

    # Collect and report results
    echo ""
    _e2e_log "━━━ E2E Results ━━━"
    echo ""

    local total_pass=0
    local total_fail=0
    local failed_combos=""

    for combo in $combos; do
        local cloud="${combo%%/*}"
        local agent="${combo##*/}"
        local result_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
        local timing_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
        local reason_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.reason"

        local result="fail"
        local elapsed="?"
        local reason="no result file"

        [[ -f "$result_file" ]] && result=$(cat "$result_file")
        [[ -f "$timing_file" ]] && elapsed=$(cat "$timing_file")
        [[ -f "$reason_file" ]] && reason=$(cat "$reason_file")

        if [[ "$result" == "pass" ]]; then
            _e2e_pass "${cloud}/${agent}  ${elapsed}s"
            total_pass=$((total_pass + 1))
        else
            _e2e_fail "${cloud}/${agent}  ${elapsed}s  (${reason})"
            total_fail=$((total_fail + 1))
            failed_combos="${failed_combos} ${combo}"
        fi
    done

    echo ""
    local summary="Total: ${total_pass} passed, ${total_fail} failed out of ${combo_count}"
    if [[ -n "${preflight_skipped:-}" ]]; then
        summary="${summary} (skipped:${preflight_skipped})"
    fi
    _e2e_log "$summary"

    # Save timings to history
    for combo in $combos; do
        local cloud="${combo%%/*}"
        local agent="${combo##*/}"
        local result_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
        local timing_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
        local result="fail"
        local elapsed="0"
        [[ -f "$result_file" ]] && result=$(cat "$result_file")
        [[ -f "$timing_file" ]] && elapsed=$(cat "$timing_file")
        _save_timing "$combo" "$elapsed" "$result"
    done

    # Optimization phase: check passing combos for slowness
    local slow_combos=""
    if [[ "$E2E_OPTIMIZE" == "1" ]]; then
        for combo in $combos; do
            local cloud="${combo%%/*}"
            local agent="${combo##*/}"
            local result_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
            local timing_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
            local result="fail"
            local elapsed="0"
            [[ -f "$result_file" ]] && result=$(cat "$result_file")
            [[ -f "$timing_file" ]] && elapsed=$(cat "$timing_file")

            if [[ "$result" == "pass" ]]; then
                local slow_reasons=""
                slow_reasons=$(_check_slow "$combo" "$elapsed") || true
                if [[ -n "$slow_reasons" ]]; then
                    slow_combos="${slow_combos} ${combo}:${elapsed}:${slow_reasons}"
                fi
            fi
        done
    fi

    if [[ -n "${slow_combos}" ]]; then
        echo ""
        _e2e_log "━━━ Optimization Phase ━━━"
        echo ""

        # Print all slow combos
        for entry in $slow_combos; do
            local combo="${entry%%:*}"
            local rest="${entry#*:}"
            local elapsed="${rest%%:*}"
            local reasons="${rest#*:}"
            printf '  \033[33m⚡\033[0m %s  %ss  (%s)\n' "$combo" "$elapsed" "$(printf '%s' "$reasons" | tr '|' ', ')"
        done
        echo ""

        # Spawn one Claude agent per slow combo, all in parallel
        local opt_pids=""
        for entry in $slow_combos; do
            local combo="${entry%%:*}"
            local rest="${entry#*:}"
            local elapsed="${rest%%:*}"
            local reasons
            reasons=$(printf '%s' "${rest#*:}" | tr '|' '\n')
            local cloud="${combo%%/*}"
            local agent="${combo##*/}"

            (
                optimize_slow_combo "$cloud" "$agent" "$elapsed" "$reasons"
            ) &
            opt_pids="${opt_pids} $!"
        done

        # Wait for all optimization agents
        for pid in $opt_pids; do
            wait "$pid" 2>/dev/null || true
        done

        # Re-run optimized combos to verify
        echo ""
        _e2e_log "━━━ Re-running Optimized Combos ━━━"
        echo ""

        for entry in $slow_combos; do
            local combo="${entry%%:*}"
            local old_elapsed="${entry#*:}"
            old_elapsed="${old_elapsed%%:*}"
            local cloud="${combo%%/*}"
            local agent="${combo##*/}"

            run_e2e_test "$cloud" "$agent" || true

            local result_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
            local timing_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
            local result="fail"
            local new_elapsed="?"
            [[ -f "$result_file" ]] && result=$(cat "$result_file")
            [[ -f "$timing_file" ]] && new_elapsed=$(cat "$timing_file")

            if [[ "$result" == "pass" ]]; then
                _e2e_pass "${combo}  ${new_elapsed}s  (was ${old_elapsed}s)"
                _save_timing "$combo" "$new_elapsed" "$result"
            else
                _e2e_fail "${combo}  ${new_elapsed}s  (optimization broke it — was ${old_elapsed}s)"
            fi
        done
    fi

    # Auto-fix failures — one Claude agent per combo, all in parallel
    if [[ "$total_fail" -gt 0 ]] && [[ "$E2E_AUTO_FIX" == "1" ]]; then
        echo ""
        _e2e_log "━━━ Auto-Fix Phase ━━━"
        echo ""

        # Spawn one agent per failing combo in parallel
        local fix_pids=""
        for combo in $failed_combos; do
            local cloud="${combo%%/*}"
            local agent="${combo##*/}"

            (
                auto_fix_combo "$cloud" "$agent"
            ) &
            fix_pids="${fix_pids} $!"
        done

        # Wait for all fix agents
        for pid in $fix_pids; do
            wait "$pid" 2>/dev/null || true
        done

        # Re-run fixed combos
        echo ""
        _e2e_log "━━━ Re-running Fixed Combos ━━━"
        echo ""

        local rerun_pass=0
        local rerun_fail=0

        for combo in $failed_combos; do
            local cloud="${combo%%/*}"
            local agent="${combo##*/}"

            run_e2e_test "$cloud" "$agent" || true

            local result_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.result"
            local timing_file="${E2E_RESULTS_DIR}/${cloud}_${agent}.timing"
            local result="fail"
            local elapsed="?"

            [[ -f "$result_file" ]] && result=$(cat "$result_file")
            [[ -f "$timing_file" ]] && elapsed=$(cat "$timing_file")

            if [[ "$result" == "pass" ]]; then
                _e2e_pass "${cloud}/${agent}  ${elapsed}s  (FIXED)"
                rerun_pass=$((rerun_pass + 1))
            else
                _e2e_fail "${cloud}/${agent}  ${elapsed}s  (still failing)"
                rerun_fail=$((rerun_fail + 1))
            fi
        done

        echo ""
        _e2e_log "Auto-fix: ${rerun_pass} fixed, ${rerun_fail} still failing"
    fi

    echo ""
    _e2e_log "━━━ E2E Complete ━━━"

    # Exit with failure if any tests failed (and weren't fixed)
    if [[ "$total_fail" -gt 0 ]]; then
        if [[ "$E2E_AUTO_FIX" == "1" ]] && [[ "${rerun_fail:-0}" -eq 0 ]]; then
            return 0
        fi
        return 1
    fi
    return 0
}

main "$@"
