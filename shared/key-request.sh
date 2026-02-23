#!/bin/bash
# Shell helpers for API key provisioning
# Sourced by qa.sh (fixtures mode) for key loading and stale key handling
#
# Requires: jq or bun, curl, REPO_ROOT set, log() function defined by caller
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
    if command -v jq &>/dev/null; then
        local auth
        auth=$(jq -r --arg c "${cloud}" '.clouds[$c].auth // ""' "${REPO_ROOT}/manifest.json" 2>/dev/null) || return 0
        # Skip CLI-based auth (login, configure, setup)
        if printf '%s' "${auth}" | grep -qiE '\b(login|configure|setup)\b'; then
            return 0
        fi
        # Empty auth means no env vars needed
        if [[ -z "${auth}" ]]; then
            return 0
        fi
        # Split on + or , and output each var name
        printf '%s' "${auth}" | tr '+,' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' || true
    else
        _MANIFEST="${REPO_ROOT}/manifest.json" _CLOUD="${cloud}" bun -e "
import fs from 'fs';
const m = JSON.parse(fs.readFileSync(process.env._MANIFEST, 'utf8'));
const auth = (m.clouds?.[process.env._CLOUD]?.auth) || '';
if (/\b(login|configure|setup)\b/i.test(auth)) process.exit(0);
for (const v of auth.split(/\s*[+,]\s*/)) {
  if (v.trim()) process.stdout.write(v.trim() + '\n');
}
" 2>/dev/null
    fi
}

# Parse manifest.json to extract cloud_key|auth_string lines for API-token clouds.
# Skips CLI-based auth (sprite login, aws configure, etc.) and empty auth fields.
# Outputs one "cloud_key|auth_string" per line to stdout.
_parse_cloud_auths() {
    local manifest_path="${1}"
    if command -v jq &>/dev/null; then
        jq -r '.clouds | to_entries[] | select(.value.auth != null and .value.auth != "") | select(.value.auth | test("\\b(login|configure|setup)\\b"; "i") | not) | "\(.key)|\(.value.auth)"' "${manifest_path}" 2>/dev/null
    else
        _MANIFEST="${manifest_path}" bun -e "
import fs from 'fs';
const m = JSON.parse(fs.readFileSync(process.env._MANIFEST, 'utf8'));
for (const [key, cloud] of Object.entries(m.clouds || {})) {
  const auth = cloud.auth || '';
  if (/\b(login|configure|setup)\b/i.test(auth)) continue;
  if (!auth.trim()) continue;
  process.stdout.write(key + '|' + auth + '\n');
}
" 2>/dev/null
    fi
}

# Try to load a single env var from config file if not already set in environment.
# Returns 0 if the var is available (already set or loaded from config), 1 if missing.
_try_load_env_var() {
    local var_name="${1}"
    local config_file="${2}"

    # SECURITY: Validate var_name to prevent command injection via export
    # Only allow uppercase letters, numbers, and underscores (standard env var naming)
    if [[ ! "${var_name}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
        log "SECURITY: Invalid env var name rejected: ${var_name}"
        return 1
    fi

    # Already set in environment?
    local current_val="${!var_name:-}"
    if [[ -n "${current_val}" ]]; then
        return 0
    fi

    # Try loading from config file
    if [[ -f "${config_file}" ]]; then
        local val
        if command -v jq &>/dev/null; then
            val=$(jq -r --arg v "${var_name}" '(.[$v] // .api_key // .token) // "" | select(. != null)' "${config_file}" 2>/dev/null)
        else
            val=$(_FILE="${config_file}" _VAR="${var_name}" bun -e "
import fs from 'fs';
const d = JSON.parse(fs.readFileSync(process.env._FILE, 'utf8'));
process.stdout.write(d[process.env._VAR] || d.api_key || d.token || '');
" 2>/dev/null)
        fi
        if [[ -n "${val}" ]]; then
            # SECURITY: Strip leading/trailing whitespace before validation
            val="$(printf '%s' "${val}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

            # SECURITY: Reject tokens containing newlines, tabs, or carriage returns
            # These could bypass downstream validation or cause header injection
            if [[ "${val}" =~ $'\n' ]] || [[ "${val}" =~ $'\t' ]] || [[ "${val}" =~ $'\r' ]]; then
                log "SECURITY: Token contains newlines/tabs for ${var_name}"
                return 1
            fi

            # Re-check non-empty after whitespace stripping
            if [[ -z "${val}" ]]; then
                return 1
            fi

            # SECURITY: Defense-in-depth — prevent malicious values from being misused
            # downstream in unquoted expansions, eval contexts, or logging
            # Allow alphanumeric plus safe chars needed by real tokens:
            #   - _ . / @  (standard API key chars)
            #   : + =      (base64 segments, URL-style formats)
            #   space       (Fly.io "FlyV1 <macaroon>" prefixed tokens)
            # Must match CLI's loadTokenFromConfig regex in cli/src/digitalocean/digitalocean.ts
            if [[ ! "${val}" =~ ^[a-zA-Z0-9._/@:+=\ -]+$ ]]; then
                log "SECURITY: Invalid characters in config value for ${var_name}"
                return 1
            fi
            # SECURITY: val is already validated against ^[a-zA-Z0-9._/@:+=\ -]+$ above,
            # and var_name is validated against ^[A-Z_][A-Z0-9_]*$ by the caller.
            # Use export NAME=VALUE (bash 3.2 compatible; printf -v requires bash 4.0+).
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
    env_vars=$(printf '%s' "${auth_string}" | tr '+,' '\n' | sed 's/^ *//;s/ *$//')

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

    if ! command -v jq &>/dev/null && ! command -v bun &>/dev/null; then
        log "Key preflight: neither jq nor bun found, skipping"
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

    # Build JSON array of provider names
    local providers_json
    if command -v jq &>/dev/null; then
        providers_json=$(printf '%s\n' ${MISSING_KEY_PROVIDERS} | jq -Rn '[inputs | select(. != "")]' 2>/dev/null) || return 0
    elif command -v bun &>/dev/null; then
        providers_json=$(_PROVIDERS="${MISSING_KEY_PROVIDERS}" bun -e "
const providers = process.env._PROVIDERS.trim().split(/\s+/).filter(Boolean);
process.stdout.write(JSON.stringify(providers));
" 2>/dev/null) || return 0
    else
        return 0
    fi

    log "Key preflight: Requesting keys for: ${MISSING_KEY_PROVIDERS}"

    # Fire-and-forget — don't block the QA cycle, but log failures
    # Use positional parameters to safely pass variables to subshell (prevents command injection)
    # Pre-construct the full JSON body to avoid shell expansion risks in subshell
    local request_body
    request_body="{\"providers\": ${providers_json}}"

    if command -v timeout &>/dev/null; then
        # Linux/GNU timeout available - wrap the subshell with timeout
        # Use --data-binary @- with heredoc to pass body via stdin (no shell expansion)
        timeout 15s bash -c '
            http_code=$(curl -s -o /dev/stderr -w "%{http_code}" --max-time 10 \
                -X POST "$1/request-batch" \
                -H "Authorization: Bearer $2" \
                -H "Content-Type: application/json" \
                --data-binary @- 2>/dev/null <<CURL_BODY
$3
CURL_BODY
            ) || http_code="000"
            case "${http_code}" in
                2*) ;; # success
                000) printf "[%s] [keys] Key preflight: WARNING — key-server unreachable at %s\n" "$(date +"%Y-%m-%d %H:%M:%S")" "$1" ;;
                401) printf "[%s] [keys] Key preflight: WARNING — 401 Unauthorized (check KEY_SERVER_SECRET)\n" "$(date +"%Y-%m-%d %H:%M:%S")" ;;
                *)   printf "[%s] [keys] Key preflight: WARNING — key-server returned HTTP %s\n" "$(date +"%Y-%m-%d %H:%M:%S")" "${http_code}" ;;
            esac
        ' -- "${key_server_url}" "${key_server_secret}" "${request_body}" &
    else
        # macOS fallback - no timeout command, rely on curl --max-time only
        # Use --data-binary @- with heredoc to pass body via stdin (no shell expansion)
        bash -c '
            http_code=$(curl -s -o /dev/stderr -w "%{http_code}" --max-time 10 \
                -X POST "$1/request-batch" \
                -H "Authorization: Bearer $2" \
                -H "Content-Type: application/json" \
                --data-binary @- 2>/dev/null <<CURL_BODY
$3
CURL_BODY
            ) || http_code="000"
            case "${http_code}" in
                2*) ;; # success
                000) printf "[%s] [keys] Key preflight: WARNING — key-server unreachable at %s\n" "$(date +"%Y-%m-%d %H:%M:%S")" "$1" ;;
                401) printf "[%s] [keys] Key preflight: WARNING — 401 Unauthorized (check KEY_SERVER_SECRET)\n" "$(date +"%Y-%m-%d %H:%M:%S")" ;;
                *)   printf "[%s] [keys] Key preflight: WARNING — key-server returned HTTP %s\n" "$(date +"%Y-%m-%d %H:%M:%S")" "${http_code}" ;;
            esac
        ' -- "${key_server_url}" "${key_server_secret}" "${request_body}" &
    fi
}

# Invalidate a cloud provider's stored key by deleting its config file
# Usage: invalidate_cloud_key CLOUD_KEY
invalidate_cloud_key() {
    local provider="${1}"

    # Validate provider name to prevent path traversal
    # Only allow lowercase letters, numbers, hyphens, and underscores (no dots to prevent ..)
    if [[ ! "${provider}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
        log "invalidate_cloud_key: invalid provider name: ${provider}"
        return 1
    fi

    local config_file="${HOME}/.config/spawn/${provider}.json"

    if [[ -f "${config_file}" ]]; then
        rm -f "${config_file}"
        log "Invalidated key config for ${provider}"
    fi
}
