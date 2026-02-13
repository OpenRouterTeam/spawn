#!/bin/bash
# Shell helpers for API key provisioning
# Sourced by qa-cycle.sh for Phase 0 key loading and Phase 1 stale key handling
#
# Requires: python3, curl, REPO_ROOT set, log() function defined by caller
#
# Functions:
#   load_cloud_keys_from_config  — Load keys from ~/.config/spawn/{cloud}.json into env
#     _parse_cloud_auths         — Extract cloud auth specs from manifest.json
#     _try_load_env_var          — Load a single env var from config file
#     _load_cloud_credentials    — Load all env vars for one cloud provider
#   request_missing_cloud_keys   — POST to key server for missing providers (fire-and-forget)
#   invalidate_cloud_key         — Delete a cloud's config file
#   get_cloud_env_vars           — Get env var names for a cloud from manifest

# Fallback log function if caller hasn't defined one
if ! type log &>/dev/null 2>&1; then
    log() { printf '[%s] [keys] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }
fi

# Get env var names for a cloud provider from manifest.json
# Usage: get_cloud_env_vars CLOUD_KEY
# Outputs one env var name per line, empty if CLI-based auth
get_cloud_env_vars() {
    local cloud="${1}"
    python3 -c "
import json, re, sys
m = json.load(open(sys.argv[1]))
auth = m.get('clouds', {}).get(sys.argv[2], {}).get('auth', '')
if re.search(r'\b(login|configure|setup)\b', auth, re.I):
    sys.exit(0)
for var in re.split(r'\s*\+\s*', auth):
    v = var.strip()
    if v:
        print(v)
" "${REPO_ROOT}/manifest.json" "${cloud}" 2>/dev/null
}

# Parse manifest.json to extract cloud_key|auth_string lines for API-token clouds.
# Skips CLI-based auth (sprite login, aws configure, etc.) and empty auth fields.
# Outputs one "cloud_key|auth_string" per line to stdout.
_parse_cloud_auths() {
    local manifest_path="${1}"
    python3 -c "
import json, re, sys
manifest = json.load(open(sys.argv[1]))
for key, cloud in manifest.get('clouds', {}).items():
    auth = cloud.get('auth', '')
    if re.search(r'\b(login|configure|setup)\b', auth, re.I):
        continue
    if not auth.strip():
        continue
    print(key + '|' + auth)
" "${manifest_path}" 2>/dev/null
}

# Try to load a single env var from config file if not already set in environment.
# Returns 0 if the var is available (already set or loaded from config), 1 if missing.
_try_load_env_var() {
    local var_name="${1}"
    local config_file="${2}"

    # Already set in environment?
    local current_val="${!var_name:-}"
    if [[ -n "${current_val}" ]]; then
        return 0
    fi

    # Try loading from config file
    if [[ -f "${config_file}" ]]; then
        local val
        val=$(python3 -c "
import json, sys
data = json.load(open(sys.argv[1]))
v = data.get(sys.argv[2], '') or data.get('api_key', '') or data.get('token', '')
print(v)
" "${config_file}" "${var_name}" 2>/dev/null)
        if [[ -n "${val}" ]]; then
            export "${var_name}=${val}"
            return 0
        fi
    fi

    return 1
}

# Load all env vars for a single cloud provider.
# Returns 0 if all vars are available, 1 if any are missing.
_load_cloud_credentials() {
    local cloud_key="${1}"
    local auth_string="${2}"

    local env_vars
    env_vars=$(printf '%s' "${auth_string}" | tr '+' '\n' | sed 's/^ *//;s/ *$//')

    local config_file="${HOME}/.config/spawn/${cloud_key}.json"
    local all_loaded=true

    while IFS= read -r var_name; do
        [[ -z "${var_name}" ]] && continue
        if ! _try_load_env_var "${var_name}" "${config_file}"; then
            all_loaded=false
        fi
    done <<< "${env_vars}"

    [[ "${all_loaded}" == "true" ]]
}

# Load cloud API keys from ~/.config/spawn/{cloud}.json into environment
# Reads manifest.json to determine which clouds need API-token auth
# Skips CLI-based auth (sprite login, aws configure, etc.)
# Sets MISSING_KEY_PROVIDERS with space-separated list of clouds that have no keys
load_cloud_keys_from_config() {
    local manifest_path="${REPO_ROOT}/manifest.json"
    if [[ ! -f "${manifest_path}" ]]; then
        log "Key preflight: manifest.json not found at ${manifest_path}"
        return 1
    fi

    if ! command -v python3 &>/dev/null; then
        log "Key preflight: python3 not found, skipping"
        return 1
    fi

    local cloud_auths
    cloud_auths=$(_parse_cloud_auths "${manifest_path}") || return 1

    local total=0
    local loaded=0
    local missing_providers=""

    while IFS='|' read -r cloud_key auth_string; do
        [[ -z "${cloud_key}" ]] && continue
        total=$((total + 1))

        if _load_cloud_credentials "${cloud_key}" "${auth_string}"; then
            loaded=$((loaded + 1))
        else
            missing_providers="${missing_providers} ${cloud_key}"
        fi
    done <<< "${cloud_auths}"

    MISSING_KEY_PROVIDERS=$(printf '%s' "${missing_providers}" | sed 's/^ //')
    log "Key preflight: ${loaded}/${total} cloud keys available"
    if [[ -n "${MISSING_KEY_PROVIDERS}" ]]; then
        log "Key preflight: Missing keys for: ${MISSING_KEY_PROVIDERS}"
    fi
}

# Request missing cloud keys from key server (fire-and-forget)
# Uses MISSING_KEY_PROVIDERS (set by load_cloud_keys_from_config or caller)
# Requires KEY_SERVER_URL and KEY_SERVER_SECRET env vars
request_missing_cloud_keys() {
    local key_server_url="${KEY_SERVER_URL:-}"
    local key_server_secret="${KEY_SERVER_SECRET:-}"

    if [[ -z "${key_server_url}" ]]; then
        return 0  # Key server not configured, skip
    fi

    if [[ -z "${key_server_secret}" ]]; then
        log "Key preflight: WARNING — KEY_SERVER_SECRET is empty, email request will fail (401)"
        return 0
    fi

    if [[ -z "${MISSING_KEY_PROVIDERS:-}" ]]; then
        return 0  # Nothing to request
    fi

    if ! command -v python3 &>/dev/null; then
        return 0
    fi

    # Build JSON array of provider names
    local providers_json
    providers_json=$(printf '%s\n' ${MISSING_KEY_PROVIDERS} | python3 -c "
import json, sys
providers = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(providers))
" 2>/dev/null) || return 0

    log "Key preflight: Requesting keys for: ${MISSING_KEY_PROVIDERS}"

    # Fire-and-forget — don't block the QA cycle, but log failures
    (
        local http_code
        http_code=$(curl -s -o /dev/stderr -w '%{http_code}' --max-time 10 \
            -X POST "${key_server_url}/request-batch" \
            -H "Authorization: Bearer ${key_server_secret}" \
            -H "Content-Type: application/json" \
            -d "{\"providers\": ${providers_json}}" 2>/dev/null) || http_code="000"
        case "${http_code}" in
            2*) ;; # success
            000) log "Key preflight: WARNING — key-server unreachable at ${key_server_url}" ;;
            401) log "Key preflight: WARNING — 401 Unauthorized (check KEY_SERVER_SECRET)" ;;
            *)   log "Key preflight: WARNING — key-server returned HTTP ${http_code}" ;;
        esac
    ) &
}

# Invalidate a cloud provider's stored key by deleting its config file
# Usage: invalidate_cloud_key CLOUD_KEY
invalidate_cloud_key() {
    local provider="${1}"

    # Validate provider name to prevent path traversal
    if [[ ! "${provider}" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
        log "invalidate_cloud_key: invalid provider name: ${provider}"
        return 1
    fi

    local config_file="${HOME}/.config/spawn/${provider}.json"

    if [[ -f "${config_file}" ]]; then
        rm -f "${config_file}"
        log "Invalidated key config for ${provider}"
    fi
}
