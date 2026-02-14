#!/bin/bash
# Record real API responses from cloud providers as test fixtures
#
# Hits safe GET-only endpoints using each cloud's existing API wrapper,
# validates the response, and saves it as pretty-printed JSON.
#
# Usage:
#   bash test/record.sh hetzner          # Record one cloud
#   bash test/record.sh hetzner vultr    # Record multiple
#   bash test/record.sh all              # All clouds with available credentials
#   bash test/record.sh --list           # Show recordable clouds + credential status

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/test/fixtures"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
RECORDED=0
SKIPPED=0
ERRORS=0

# Whether to prompt for missing credentials (set by 'all' vs 'allsaved')
PROMPT_FOR_CREDS=true

# All clouds with REST APIs that we can record from
ALL_RECORDABLE_CLOUDS="hetzner digitalocean vultr linode lambda civo upcloud binarylane ovh scaleway genesiscloud kamatera latitude hyperstack atlanticnet hostkey cloudsigma webdock serverspace gcore"

# --- Endpoint registry ---
# Declare endpoints as string literal for each cloud
# Format: "fixture_name:endpoint" (one per line, indented)
_ENDPOINTS_hetzner="
server_types:/server_types?per_page=50
locations:/locations
ssh_keys:/ssh_keys
servers:/servers
"

_ENDPOINTS_digitalocean="
account:/account
ssh_keys:/account/keys
droplets:/droplets
sizes:/sizes
regions:/regions
"

_ENDPOINTS_vultr="
account:/account
ssh_keys:/ssh-keys
instances:/instances
plans:/plans
regions:/regions
"

_ENDPOINTS_linode="
profile:/profile
ssh_keys:/profile/sshkeys
instances:/linode/instances
types:/linode/types
regions:/regions
"

_ENDPOINTS_lambda="
instances:/instances
ssh_keys:/ssh-keys
instance_types:/instance-types
"

_ENDPOINTS_civo="
regions:/regions
instances:/instances
sshkeys:/sshkeys
networks:/networks
disk_images:/disk_images
"

_ENDPOINTS_upcloud="
servers:/server
server_sizes:/server_size
"

_ENDPOINTS_binarylane="
sizes:/sizes
regions:/regions
servers:/servers
"

_ENDPOINTS_ovh="
flavors:/cloud/project/\${OVH_PROJECT_ID:-MISSING}/flavor
images:/cloud/project/\${OVH_PROJECT_ID:-MISSING}/image
ssh_keys:/cloud/project/\${OVH_PROJECT_ID:-MISSING}/sshkey
"

_ENDPOINTS_scaleway="
servers:/servers
images:/images?per_page=10
"

_ENDPOINTS_genesiscloud="
ssh_keys:/ssh-keys
instances:/instances
"

_ENDPOINTS_kamatera="
server_options:/service/server
"

_ENDPOINTS_latitude="
ssh_keys:/ssh_keys
plans:/plans
regions:/regions
"

_ENDPOINTS_hyperstack="
flavors:/core/flavors
ssh_keys:/core/keypairs
"

_ENDPOINTS_atlanticnet="
ssh_keys:list-sshkeys
plans:describe-plan
"

_ENDPOINTS_hostkey="
services:/v1/services
ssh_keys:/ssh_keys
"

_ENDPOINTS_cloudsigma="
balance:/balance/
keypairs:/keypairs/
servers:/servers/
"

_ENDPOINTS_webdock="
account:/account
publicKeys:/account/publicKeys
servers:/servers
profiles:/profiles
locations:/locations
"

_ENDPOINTS_serverspace="
project:/project
servers:/servers
ssh-keys:/ssh-keys
locations:/locations
images:/images
"

_ENDPOINTS_gcore="
projects:/cloud/v1/projects
ssh_keys:/cloud/v1/ssh_keys/\${GCORE_PROJECT_ID:-MISSING}
instances:/cloud/v1/instances/\${GCORE_PROJECT_ID:-MISSING}/\${GCORE_REGION:-ed-1}
images:/cloud/v1/images/\${GCORE_PROJECT_ID:-MISSING}/\${GCORE_REGION:-ed-1}
flavors:/cloud/v1/flavors/\${GCORE_PROJECT_ID:-MISSING}/\${GCORE_REGION:-ed-1}
"

get_endpoints() {
    local cloud="$1"
    local var_name="_ENDPOINTS_${cloud}"
    if [[ -n "${!var_name:-}" ]]; then
        printf '%s\n' "${!var_name}" | grep -v '^$'
    fi
}

# --- Multi-credential cloud specs ---
# Returns "config_key:env_var" pairs (one per line) for multi-credential clouds.
# Single-credential clouds return nothing (handled by get_auth_env_var).
_get_multi_cred_spec() {
    local cloud="$1"
    case "$cloud" in
        ovh)
            printf '%s\n' \
                "application_key:OVH_APPLICATION_KEY" \
                "application_secret:OVH_APPLICATION_SECRET" \
                "consumer_key:OVH_CONSUMER_KEY" \
                "project_id:OVH_PROJECT_ID"
            ;;
        upcloud)
            printf '%s\n' \
                "username:UPCLOUD_USERNAME" \
                "password:UPCLOUD_PASSWORD"
            ;;
        kamatera)
            printf '%s\n' \
                "client_id:KAMATERA_API_CLIENT_ID" \
                "secret:KAMATERA_API_SECRET"
            ;;
        atlanticnet)
            printf '%s\n' \
                "api_key:ATLANTICNET_API_KEY" \
                "api_private_key:ATLANTICNET_API_PRIVATE_KEY"
            ;;
        cloudsigma)
            printf '%s\n' \
                "email:CLOUDSIGMA_EMAIL" \
                "password:CLOUDSIGMA_PASSWORD"
            ;;
    esac
}

# Load multiple fields from a JSON config file and export as env vars.
# Arguments: CONFIG_FILE SPEC...  (each spec is "config_key:ENV_VAR")
_load_multi_config_from_file() {
    local config_file="$1"; shift
    [[ -f "$config_file" ]] || return 1

    local config_keys=() env_vars=()
    local spec
    for spec in "$@"; do
        config_keys+=("${spec%%:*}")
        env_vars+=("${spec#*:}")
    done

    local vals
    vals=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print('\t'.join(d.get(k, '') for k in sys.argv[2:]))
except: pass
" "$config_file" "${config_keys[@]}" 2>/dev/null) || return 1

    [[ -n "${vals:-}" ]] || return 1

    local IFS=$'\t'
    local fields
    read -ra fields <<< "$vals"
    local i
    for i in "${!env_vars[@]}"; do
        # SECURITY: Validate env var name before export
        if [[ -n "${fields[$i]:-}" ]]; then
            if [[ ! "${env_vars[$i]}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
                echo "SECURITY: Invalid env var name rejected: ${env_vars[$i]}" >&2
                return 1
            fi
            export "${env_vars[$i]}=${fields[$i]}"
        fi
    done
    return 0
}

# Save multiple env vars to a JSON config file.
# Arguments: CONFIG_FILE SPEC...  (each spec is "config_key:ENV_VAR")
_save_multi_config_to_file() {
    local config_file="$1"; shift

    local py_args=()
    local py_keys=""
    local idx=1
    local spec
    for spec in "$@"; do
        local config_key="${spec%%:*}"
        local env_var="${spec#*:}"
        eval "local val=\"\${${env_var}:-}\""
        py_args+=("$val")
        py_keys="${py_keys}'${config_key}': sys.argv[${idx}], "
        idx=$((idx + 1))
    done

    python3 -c "
import json, sys
print(json.dumps({${py_keys}}, indent=2))
" "${py_args[@]}" > "$config_file"
}

# --- Auth env var check ---
get_auth_env_var() {
    local cloud="$1"
    case "$cloud" in
        hetzner)       printf "HCLOUD_TOKEN" ;;
        digitalocean)  printf "DO_API_TOKEN" ;;
        vultr)         printf "VULTR_API_KEY" ;;
        linode)        printf "LINODE_API_TOKEN" ;;
        lambda)        printf "LAMBDA_API_KEY" ;;
        civo)          printf "CIVO_API_TOKEN" ;;
        upcloud)       printf "UPCLOUD_USERNAME" ;;
        binarylane)    printf "BINARYLANE_API_TOKEN" ;;
        ovh)           printf "OVH_APPLICATION_KEY" ;;
        scaleway)      printf "SCW_SECRET_KEY" ;;
        genesiscloud)  printf "GENESIS_API_KEY" ;;
        kamatera)      printf "KAMATERA_API_CLIENT_ID" ;;
        latitude)      printf "LATITUDE_API_KEY" ;;
        hyperstack)    printf "HYPERSTACK_API_KEY" ;;
        atlanticnet)   printf "ATLANTICNET_API_KEY" ;;
        hostkey)       printf "HOSTKEY_API_KEY" ;;
        cloudsigma)    printf "CLOUDSIGMA_EMAIL" ;;
        webdock)       printf "WEBDOCK_API_TOKEN" ;;
        serverspace)   printf "SERVERSPACE_API_KEY" ;;
        gcore)         printf "GCORE_API_TOKEN" ;;
    esac
}

# Try loading token from ~/.config/spawn/{cloud}.json (same config the agent scripts use)
try_load_config() {
    local cloud="$1"
    local env_var
    env_var=$(get_auth_env_var "$cloud")

    # Already set via env var — nothing to do
    eval "local current_val=\"\${${env_var}:-}\""
    if [[ -n "$current_val" ]]; then
        return 0
    fi

    local config_file="$HOME/.config/spawn/${cloud}.json"

    # Multi-credential clouds (OVH, AtlanticNet, CloudSigma, etc.)
    local specs
    specs=$(_get_multi_cred_spec "$cloud")
    if [[ -n "$specs" ]]; then
        local spec_args=()
        while IFS= read -r line; do
            spec_args+=("$line")
        done <<< "$specs"
        _load_multi_config_from_file "$config_file" "${spec_args[@]}" || true
        return 0
    fi

    # Standard single-token config
    if [[ -f "$config_file" ]]; then
        # SECURITY: Validate env var name before export
        if [[ ! "${env_var}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            echo "SECURITY: Invalid env var name rejected: ${env_var}" >&2
            return 1
        fi
        local token
        token=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('api_key','') or d.get('token',''))" "$config_file" 2>/dev/null) || true
        if [[ -n "${token:-}" ]]; then
            export "${env_var}=${token}"
        fi
    fi
}

has_credentials() {
    local cloud="$1"

    # Try loading from config file first
    try_load_config "$cloud"

    # Multi-credential clouds: check all env vars from spec
    local specs
    specs=$(_get_multi_cred_spec "$cloud")
    if [[ -n "$specs" ]]; then
        local line
        while IFS= read -r line; do
            local env_var="${line#*:}"
            eval "[[ -n \"\${${env_var}:-}\" ]]" || return 1
        done <<< "$specs"
        return 0
    fi

    # Single-credential clouds
    local env_var
    env_var=$(get_auth_env_var "$cloud")
    eval "[[ -n \"\${${env_var}:-}\" ]]"
}

# Save credentials to ~/.config/spawn/{cloud}.json for future use
save_config() {
    local cloud="$1"
    local config_dir="$HOME/.config/spawn"
    local config_file="${config_dir}/${cloud}.json"
    mkdir -p "$config_dir"

    # Multi-credential clouds
    local specs
    specs=$(_get_multi_cred_spec "$cloud")
    if [[ -n "$specs" ]]; then
        local spec_args=()
        while IFS= read -r line; do
            spec_args+=("$line")
        done <<< "$specs"
        _save_multi_config_to_file "$config_file" "${spec_args[@]}"
    else
        # Standard single-token config
        local env_var
        env_var=$(get_auth_env_var "$cloud")
        eval "local val=\"\${${env_var}:-}\""
        python3 -c "import json, sys; print(json.dumps({'api_key': sys.argv[1]}, indent=2))" "$val" > "$config_file"
    fi
    printf '%b\n' "  ${GREEN}saved${NC} → ${config_file}"
}

# Prompt user for missing credentials, export them, and save to config
prompt_credentials() {
    local cloud="$1"
    local vars_needed=""
    local val=""

    # Multi-credential clouds: extract env var names from spec
    local specs
    specs=$(_get_multi_cred_spec "$cloud")
    if [[ -n "$specs" ]]; then
        local line
        while IFS= read -r line; do
            vars_needed="${vars_needed} ${line#*:}"
        done <<< "$specs"
    else
        vars_needed=$(get_auth_env_var "$cloud")
    fi

    for var_name in $vars_needed; do
        # SECURITY: Validate env var name before using in eval or export
        if [[ ! "${var_name}" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            echo "SECURITY: Invalid env var name rejected: ${var_name}" >&2
            return 1
        fi
        eval "local current=\"\${${var_name}:-}\""
        if [[ -n "$current" ]]; then
            continue
        fi
        printf "  Enter %s (press Enter to skip %s): " "$var_name" "$cloud" >&2
        read -r val
        if [[ -z "$val" ]]; then
            return 1
        fi
        export "${var_name}=${val}"
    done

    # Save so they don't have to enter again
    save_config "$cloud"
    return 0
}

# --- API call dispatcher ---
# Each cloud sources its lib and calls its wrapper function
call_api() {
    local cloud="$1"
    local endpoint="$2"
    case "$cloud" in
        hetzner)       hetzner_api GET "$endpoint" ;;
        digitalocean)  do_api GET "$endpoint" ;;
        vultr)         vultr_api GET "$endpoint" ;;
        linode)        linode_api GET "$endpoint" ;;
        lambda)        lambda_api GET "$endpoint" "" ;;
        civo)          civo_api GET "$endpoint" ;;
        upcloud)       upcloud_api GET "$endpoint" ;;
        binarylane)    binarylane_api GET "$endpoint" ;;
        ovh)           ovh_api_call GET "$endpoint" ;;
        scaleway)      scaleway_instance_api GET "$endpoint" ;;
        genesiscloud)  genesis_api GET "$endpoint" ;;
        kamatera)      kamatera_api GET "$endpoint" ;;
        latitude)      latitude_api GET "$endpoint" ;;
        hyperstack)    hyperstack_api GET "$endpoint" ;;
        atlanticnet)   atlanticnet_api "$endpoint" ;;
        hostkey)       hostkey_api "$endpoint" ;;
        cloudsigma)    cloudsigma_api GET "$endpoint" ;;
        webdock)       webdock_api GET "$endpoint" ;;
        serverspace)   serverspace_api GET "$endpoint" ;;
        gcore)         gcore_api GET "$endpoint" ;;
    esac
}

# --- Validation ---
is_valid_json() {
    python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null
}

has_api_error() {
    local cloud="$1"
    local response="$2"

    echo "$response" | python3 << VALIDATION_EOF 2>/dev/null
import json, sys
d = json.loads(sys.stdin.read())
cloud = '$cloud'

# Helper: data keys that indicate success responses (not errors)
success_keys = {'servers','images','ssh_keys','flavors','sizes','regions','count','results','id','name','slug','status','ipv4'}

error_checks = {
    'hetzner': lambda d: d.get('error') and isinstance(d.get('error'), dict),
    'digitalocean': lambda d: 'id' in d and isinstance(d.get('id'), str) and 'message' in d,
    'vultr': lambda d: 'error' in d and d['error'],
    'genesiscloud': lambda d: 'error' in d and d['error'],
    'hyperstack': lambda d: 'error' in d and d['error'],
    'linode': lambda d: 'errors' in d and d['errors'],
    'ovh': lambda d: 'message' in d and len(d) <= 3 and not any(k in d for k in success_keys),
    'scaleway': lambda d: 'message' in d and len(d) <= 3 and not any(k in d for k in success_keys),
    'binarylane': lambda d: 'message' in d and len(d) <= 3 and not any(k in d for k in success_keys),
    'civo': lambda d: 'reason' in d and 'result' in d and d['result'] == 'failed',
    'lambda': lambda d: d.get('error') and isinstance(d.get('error'), dict),
    'kamatera': lambda d: d.get('status') == 'error',
    'latitude': lambda d: 'error' in d or ('errors' in d and d['errors']),
    'atlanticnet': lambda d: 'error' in d and d['error'],
    'hostkey': lambda d: 'error' in d and d['error'],
    'cloudsigma': lambda d: 'error_message' in d or 'error_type' in d,
    'webdock': lambda d: 'message' in d and len(d) <= 3 and not any(k in d for k in success_keys),
    'serverspace': lambda d: 'error' in d and d['error'],
    'gcore': lambda d: ('message' in d and len(d) <= 3 and not any(k in d for k in success_keys)) or ('detail' in d and len(d) <= 2),
}

if cloud in error_checks:
    sys.exit(0 if error_checks[cloud](d) else 1)
else:
    sys.exit(1)
VALIDATION_EOF
}

# --- Pretty print JSON ---
pretty_json() {
    python3 -c "import json,sys; print(json.dumps(json.loads(sys.stdin.read()), indent=2, sort_keys=True))"
}

# --- Live create+delete cycle (captures real POST/DELETE responses) ---
# Creates a server with a timestamped name, records the response, then deletes it.
# These functions access cloud_recorded, cloud_errors, metadata_entries from the
# calling scope (record_cloud) via bash dynamic scoping — no namerefs needed.
_record_live_cycle() {
    local cloud="$1"
    local fixture_dir="$2"

    # Source cloud lib so API wrappers are available (dynamic scoping
    # lets _live_* functions update caller's counters/metadata)
    source "${REPO_ROOT}/${cloud}/lib/common.sh" 2>/dev/null || true

    case "$cloud" in
        hetzner)       _live_hetzner "$fixture_dir" ;;
        digitalocean)  _live_digitalocean "$fixture_dir" ;;
        vultr)         _live_vultr "$fixture_dir" ;;
        linode)        _live_linode "$fixture_dir" ;;
        civo)          _live_civo "$fixture_dir" ;;
        atlanticnet)   _live_atlanticnet "$fixture_dir" ;;
        serverspace)   _live_serverspace "$fixture_dir" ;;
        gcore)         _live_gcore "$fixture_dir" ;;
        *)  return 0 ;;  # No live cycle for this cloud yet
    esac
}

# Save a live fixture and update the caller's counters/metadata
_save_live_fixture() {
    local fixture_dir="$1"
    local fixture_name="$2"
    local endpoint="$3"
    local response="$4"

    if [[ -z "$response" ]]; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — empty response"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    if ! echo "$response" | is_valid_json; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — invalid JSON"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    # Check for API error responses (cloud var is available via dynamic scoping)
    if has_api_error "$cloud" "$response"; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — API error response"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    echo "$response" | pretty_json > "${fixture_dir}/${fixture_name}.json"
    printf '%b\n' "  ${GREEN}  ok${NC} ${fixture_name} (live)"

    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    metadata_entries="${metadata_entries}    \"${fixture_name}\": {\"endpoint\": \"${endpoint}\", \"type\": \"live\", \"recorded_at\": \"${ts}\"},
"
    cloud_recorded=$((cloud_recorded + 1))
    return 0
}

# Generic live create+delete cycle for any cloud provider.
# Calls a per-cloud builder function that prints the API body to stdout,
# then runs the shared create -> save -> extract-id -> delete -> save flow.
#
# Usage: _live_create_delete_cycle FIXTURE_DIR API_FUNC CREATE_ENDPOINT \
#          DELETE_ENDPOINT_TEMPLATE ID_PY_EXPR BUILDER_FUNC \
#          [DELETE_DELAY] [EMPTY_DELETE_FALLBACK]
#
# Arguments:
#   FIXTURE_DIR              - Directory for fixture JSON files
#   API_FUNC                 - Cloud API function (e.g., "hetzner_api")
#   CREATE_ENDPOINT          - POST endpoint (e.g., "/servers")
#   DELETE_ENDPOINT_TEMPLATE - DELETE endpoint with {id} placeholder
#   ID_PY_EXPR               - Python expression to extract ID from response (receives 'd')
#   BUILDER_FUNC             - Function that prints the JSON create body to stdout
#   DELETE_DELAY             - Seconds to sleep before delete (default: 3)
#   EMPTY_DELETE_FALLBACK    - JSON to use when DELETE returns empty body (optional)
# Extract resource ID from API response using Python expression
# Sets global resource_id; returns 0 on success, 1 on failure
_extract_resource_id() {
    local response="$1" id_py_expr="$2"

    resource_id=$(echo "$response" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(${id_py_expr})" 2>/dev/null) || true

    if [[ -z "${resource_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract resource ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    return 0
}

# Handle delete response, using fallback if empty
_handle_delete_response() {
    local response="$1" empty_delete_fallback="$2"

    if [[ -z "$response" && -n "$empty_delete_fallback" ]]; then
        echo "$empty_delete_fallback"
    else
        echo "$response"
    fi
}

_live_create_delete_cycle() {
    local fixture_dir="$1"
    local api_func="$2"
    local create_endpoint="$3"
    local delete_endpoint_template="$4"
    local id_py_expr="$5"
    local builder_func="$6"
    local delete_delay="${7:-3}"
    local empty_delete_fallback="${8:-}"

    local body
    body=$("${builder_func}" "${fixture_dir}") || return 0

    local create_response
    create_response=$("${api_func}" POST "${create_endpoint}" "$body")

    _save_live_fixture "$fixture_dir" "create_server" "POST ${create_endpoint}" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create — skipping delete fixture"
        return 0
    }

    local resource_id
    _extract_resource_id "$create_response" "$id_py_expr" || return 0

    printf '%b\n' "  ${CYAN}live${NC} Created (ID: ${resource_id}). Deleting..."
    sleep "$delete_delay"

    local delete_endpoint="${delete_endpoint_template/\{id\}/${resource_id}}"
    local delete_response
    delete_response=$("${api_func}" DELETE "${delete_endpoint}")

    delete_response=$(_handle_delete_response "$delete_response" "$empty_delete_fallback")

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE ${delete_endpoint_template}" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Resource ${resource_id} deleted"
}

# --- Per-cloud body builders ---
# Each prints the JSON create body to stdout and logs setup info to stderr.

_live_hetzner_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test server '${name}' (cx23, nbg1)..." >&2

    local ssh_keys_response
    ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(json.dumps([k['id'] for k in d.get('ssh_keys', [])]))
" 2>/dev/null) || ssh_key_ids="[]"

    python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1], 'server_type': 'cx23', 'location': 'nbg1',
    'image': 'ubuntu-24.04', 'ssh_keys': json.loads(sys.argv[2]),
    'start_after_create': True
}))
" "$name" "$ssh_key_ids"
}

_live_hetzner() {
    _live_create_delete_cycle "$1" hetzner_api "/servers" "/servers/{id}" \
        "d['server']['id']" _live_hetzner_body 2
}

_live_digitalocean_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test droplet '${name}' (s-1vcpu-512mb-10gb, nyc3)..." >&2

    local ssh_keys_response
    ssh_keys_response=$(do_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(json.dumps([k['id'] for k in d.get('ssh_keys', [])]))
" 2>/dev/null) || ssh_key_ids="[]"

    python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1], 'region': 'nyc3', 'size': 's-1vcpu-512mb-10gb',
    'image': 'ubuntu-24-04-x64', 'ssh_keys': json.loads(sys.argv[2])
}))
" "$name" "$ssh_key_ids"
}

_live_digitalocean() {
    _live_create_delete_cycle "$1" do_api "/droplets" "/droplets/{id}" \
        "d['droplet']['id']" _live_digitalocean_body 3 \
        '{"status":"deleted","http_code":204}'
}

_live_vultr_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test instance '${name}' (vc2-1c-1gb, ewr)..." >&2

    local ssh_keys_response
    ssh_keys_response=$(vultr_api GET "/ssh-keys")
    local ssh_key_id
    ssh_key_id=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
keys = d.get('ssh_keys', [])
print(keys[0]['id'] if keys else '')
" 2>/dev/null) || ssh_key_id=""

    python3 -c "
import json, sys
body = {'label': sys.argv[1], 'region': 'ewr', 'plan': 'vc2-1c-1gb', 'os_id': 2284}
if sys.argv[2]:
    body['sshkey_id'] = [sys.argv[2]]
print(json.dumps(body))
" "$name" "$ssh_key_id"
}

_live_vultr() {
    _live_create_delete_cycle "$1" vultr_api "/instances" "/instances/{id}" \
        "d['instance']['id']" _live_vultr_body 5
}

_live_linode_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test linode '${name}' (g6-nanode-1, us-east)..." >&2

    local ssh_keys_response
    ssh_keys_response=$(linode_api GET "/profile/sshkeys")
    local ssh_keys_json
    ssh_keys_json=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(json.dumps([k['ssh_key'] for k in d.get('data', [])]))
" 2>/dev/null) || ssh_keys_json="[]"

    local root_pass
    root_pass=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#') for _ in range(24)))")

    python3 -c "
import json, sys
print(json.dumps({
    'label': sys.argv[1], 'region': 'us-east', 'type': 'g6-nanode-1',
    'image': 'linode/ubuntu24.04', 'root_pass': sys.argv[2],
    'authorized_keys': json.loads(sys.argv[3])
}))
" "$name" "$root_pass" "$ssh_keys_json"
}

_live_linode() {
    _live_create_delete_cycle "$1" linode_api "/linode/instances" "/linode/instances/{id}" \
        "d['id']" _live_linode_body 3
}

_live_civo_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test instance '${name}' (g3.xsmall, nyc1)..." >&2

    local networks_response
    networks_response=$(civo_api GET "/networks")
    local network_id
    network_id=$(echo "$networks_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
nets = d if isinstance(d, list) else d.get('items', d.get('networks', []))
for n in nets:
    if n.get('default', False):
        print(n['id']); break
else:
    if nets: print(nets[0]['id'])
" 2>/dev/null) || network_id=""

    local disk_images_response
    disk_images_response=$(civo_api GET "/disk_images")
    local template_id
    template_id=$(echo "$disk_images_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
imgs = d if isinstance(d, list) else d.get('items', d.get('disk_images', []))
for img in imgs:
    name = img.get('name', '').lower()
    if 'ubuntu' in name and ('24' in name or '22' in name):
        print(img['id']); break
else:
    if imgs: print(imgs[0]['id'])
" 2>/dev/null) || template_id=""

    python3 -c "
import json, sys
body = {'hostname': sys.argv[1], 'size': 'g3.xsmall', 'region': 'nyc1'}
if sys.argv[2]: body['network_id'] = sys.argv[2]
if sys.argv[3]: body['template_id'] = sys.argv[3]
print(json.dumps(body))
" "$name" "$network_id" "$template_id"
}

_live_civo() {
    _live_create_delete_cycle "$1" civo_api "/instances" "/instances/{id}" \
        "d['id']" _live_civo_body 3
}

_live_atlanticnet_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    printf '%b\n' "  ${CYAN}live${NC} Creating test server '${name}' (G2.2GB, USEAST2)..." >&2

    local ssh_keys_response
    ssh_keys_response=$(atlanticnet_api list-sshkeys)
    local ssh_key_name
    ssh_key_name=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
items = d.get('list-sshkeysresponse', {}).get('sshkeylist', {}).get('item', [])
if isinstance(items, dict): items = [items]
for k in items:
    name = k.get('ssh_key_name', '')
    if 'spawn' in name.lower():
        print(name); break
else:
    if items: print(items[0].get('ssh_key_name', ''))
" 2>/dev/null) || ssh_key_name=""

    # Atlantic.Net uses query params, not JSON body
    # We need to output parameters for atlanticnet_api to use
    echo "server_name:$name planname:G2.2GB imageid:ubuntu-24.04_64bit vm_location:USEAST2 ServerQty:1 key_id:$ssh_key_name"
}

_live_atlanticnet() {
    local fixture_dir="$1"
    local params
    params=$(_live_atlanticnet_body "$fixture_dir") || return 0

    # Parse params and create server
    local create_response
    create_response=$(atlanticnet_api run-instance $params)

    _save_live_fixture "$fixture_dir" "create_server" "run-instance" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create — skipping delete fixture"
        return 0
    }

    local instance_id
    instance_id=$(echo "$create_response" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read())
print(d.get('run-instanceresponse',{}).get('instancesSet',{}).get('item',{}).get('instanceid',''))
" 2>/dev/null) || instance_id=""

    if [[ -z "${instance_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract instance ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Created (ID: ${instance_id}). Deleting..."
    sleep 3

    local delete_response
    delete_response=$(atlanticnet_api terminate-instance instanceid "$instance_id")

    _save_live_fixture "$fixture_dir" "delete_server" "terminate-instance" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Instance ${instance_id} deleted"
}

_live_hostkey() {
    local fixture_dir="$1"
    # HOSTKEY live testing not implemented yet - requires instance creation via eq/order_instance
    # Skipping live fixtures for now
    return 0
}

_live_cloudsigma() {
    local fixture_dir="$1"
    printf '%b\n' "  ${YELLOW}skip${NC} CloudSigma live test (requires drive cloning, complex multi-step process)" >&2
    return 0
}

_live_webdock() {
    local fixture_dir="$1"
    printf '%b\n' "  ${YELLOW}skip${NC} Webdock live test (not implemented yet)" >&2
    return 0
}

_live_serverspace() {
    local fixture_dir="$1"
    printf '%b\n' "  ${YELLOW}skip${NC} ServerSpace live test (async task-based creation, not implemented yet)" >&2
    return 0
}

_live_gcore_body() {
    local fixture_dir="$1"
    local name="spawn-record-$(date +%s)"
    local region="${GCORE_REGION:-ed-1}"
    local project_id="${GCORE_PROJECT_ID:-}"
    printf '%b\n' "  ${CYAN}live${NC} Creating test instance '${name}' (g1-standard-1-2, ${region})..." >&2

    local ssh_keys_response
    ssh_keys_response=$(gcore_api GET "/cloud/v1/ssh_keys/${project_id}")
    local ssh_key_name
    ssh_key_name=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
keys = d.get('results', [])
print(keys[0]['name'] if keys else '')
" 2>/dev/null) || ssh_key_name=""

    local image_id
    image_id=$(echo "$(gcore_api GET "/cloud/v1/images/${project_id}/${region}")" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
for img in d.get('results', []):
    if 'ubuntu' in img.get('name', '').lower() and '24' in img.get('os_version', ''):
        print(img['id']); break
else:
    imgs = d.get('results', [])
    if imgs: print(imgs[0]['id'])
" 2>/dev/null) || image_id=""

    python3 -c "
import json, sys
body = {
    'name': sys.argv[1],
    'flavor': 'g1-standard-1-2',
    'volumes': [{'source': 'image', 'image_id': sys.argv[3], 'size': 20, 'boot_index': 0}],
    'interfaces': [{'type': 'external'}]
}
if sys.argv[2]:
    body['keypair_name'] = sys.argv[2]
print(json.dumps(body))
" "$name" "$ssh_key_name" "$image_id"
}

_live_gcore() {
    local project_id="${GCORE_PROJECT_ID:-}"
    local region="${GCORE_REGION:-ed-1}"
    _live_create_delete_cycle "$1" gcore_api \
        "/cloud/v2/instances/${project_id}/${region}" \
        "/cloud/v1/instances/${project_id}/${region}/{id}" \
        "d.get('instances',[''])[0]" _live_gcore_body 5
}

# --- Record one cloud ---
# Check credentials and prompt if needed; returns 1 to skip this cloud
_record_ensure_credentials() {
    local cloud="$1"
    if has_credentials "$cloud"; then
        return 0
    fi

    local env_var
    env_var=$(get_auth_env_var "$cloud")
    if [[ "$PROMPT_FOR_CREDS" == "true" ]]; then
        printf '%b\n' "${CYAN}━━━ ${cloud} ━━━${NC}"
        printf '%b\n' "  ${YELLOW}missing${NC} ${env_var}"
        if prompt_credentials "$cloud"; then
            return 0
        fi
        printf '%b\n' "  ${YELLOW}skip${NC} ${cloud}"
    else
        printf '%b\n' "  ${YELLOW}skip${NC} ${cloud} — ${env_var} not set"
    fi
    SKIPPED=$((SKIPPED + 1))
    return 1
}

# Record a single endpoint fixture; increments cloud_recorded/cloud_errors
# Usage: _record_endpoint CLOUD FIXTURE_DIR FIXTURE_NAME ENDPOINT
# Validate API response and report errors
# Returns 0 if valid, 1 if invalid/error
_validate_endpoint_response() {
    local cloud="$1" fixture_name="$2" response="$3"

    if [[ -z "$response" ]]; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — empty response"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    if ! echo "$response" | is_valid_json; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — invalid JSON"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    if has_api_error "$cloud" "$response"; then
        printf '%b\n' "  ${RED}fail${NC} ${fixture_name} — API error response"
        cloud_errors=$((cloud_errors + 1))
        return 1
    fi

    return 0
}

# Record endpoint response to fixture file and update metadata
_save_endpoint_fixture() {
    local fixture_dir="$1" fixture_name="$2" endpoint="$3" response="$4"

    echo "$response" | pretty_json > "${fixture_dir}/${fixture_name}.json"
    printf '%b\n' "  ${GREEN}  ok${NC} ${fixture_name} → fixtures/${cloud}/${fixture_name}.json"
    cloud_recorded=$((cloud_recorded + 1))

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    metadata_entries="${metadata_entries}    \"${fixture_name}\": {\"endpoint\": \"${endpoint}\", \"recorded_at\": \"${timestamp}\"},
"
}

_record_endpoint() {
    local cloud="$1" fixture_dir="$2" fixture_name="$3" endpoint="$4"

    # Call API in a subshell that sources the cloud lib
    local tmp_response
    tmp_response=$(mktemp /tmp/spawn-record-XXXXXX)

    (
        source "${REPO_ROOT}/${cloud}/lib/common.sh" 2>/dev/null
        call_api "$cloud" "$endpoint" 2>/dev/null
    ) > "$tmp_response" 2>/dev/null || true

    local response
    response=$(cat "$tmp_response")
    rm -f "$tmp_response"

    _validate_endpoint_response "$cloud" "$fixture_name" "$response" || return 0
    _save_endpoint_fixture "$fixture_dir" "$fixture_name" "$endpoint" "$response"
}

# Write the _metadata.json file for a cloud's fixtures
_record_write_metadata() {
    local cloud="$1" fixture_dir="$2"

    local meta_timestamp
    meta_timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Remove trailing comma and newline from metadata_entries
    metadata_entries=$(printf '%s' "$metadata_entries" | sed '$ s/,$//')

    cat > "${fixture_dir}/_metadata.json" << METADATA_EOF
{
  "cloud": "${cloud}",
  "recorded_at": "${meta_timestamp}",
  "fixtures": {
${metadata_entries}
  }
}
METADATA_EOF
}

record_cloud() {
    local cloud="$1"

    _record_ensure_credentials "$cloud" || return 0

    printf '%b\n' "${CYAN}━━━ Recording ${cloud} ━━━${NC}"

    local fixture_dir="${FIXTURES_DIR}/${cloud}"
    mkdir -p "$fixture_dir"

    local endpoints
    endpoints=$(get_endpoints "$cloud")

    local cloud_recorded=0
    local cloud_errors=0
    local metadata_entries=""

    while IFS=: read -r fixture_name endpoint; do
        [[ -z "$fixture_name" ]] && continue
        _record_endpoint "$cloud" "$fixture_dir" "$fixture_name" "$endpoint"
    done <<< "$endpoints"

    # Live create+delete cycle for write endpoint fixtures
    _record_live_cycle "$cloud" "$fixture_dir" cloud_recorded cloud_errors metadata_entries || true

    _record_write_metadata "$cloud" "$fixture_dir"

    RECORDED=$((RECORDED + cloud_recorded))
    ERRORS=$((ERRORS + cloud_errors))

    if [[ "$cloud_errors" -eq 0 ]]; then
        printf '%b\n' "  ${GREEN}done${NC} ${cloud_recorded} fixtures recorded"
    else
        printf '%b\n' "  ${YELLOW}done${NC} ${cloud_recorded} recorded, ${cloud_errors} failed"
    fi
    printf '\n'
}

# Format env var name for list display
# Args: cloud
_format_env_var_display() {
    local cloud="$1"
    local env_var
    env_var=$(get_auth_env_var "$cloud")

    # For multi-var clouds, show required env vars from spec
    local specs
    specs=$(_get_multi_cred_spec "$cloud")
    if [[ -n "$specs" ]]; then
        local first_var var_count
        first_var=$(head -1 <<< "$specs")
        first_var="${first_var#*:}"
        var_count=$(wc -l <<< "$specs" | tr -d ' ')
        if [[ "$var_count" -gt 1 ]]; then
            env_var="${first_var} + $((var_count - 1)) more"
        else
            env_var="$first_var"
        fi
    fi
    printf '%s' "$env_var"
}

# --- List mode ---
list_clouds() {
    printf '%b\n' "${CYAN}Recordable clouds:${NC}"
    printf '\n'
    printf "  %-15s %-30s %s\n" "CLOUD" "AUTH ENV VAR" "STATUS"
    printf "  %-15s %-30s %s\n" "-----" "------------" "------"

    local ready_count=0
    for cloud in $ALL_RECORDABLE_CLOUDS; do
        local env_var
        env_var=$(_format_env_var_display "$cloud")
        local status

        if has_credentials "$cloud"; then
            status=$(printf '%b' "${GREEN}ready${NC}")
            ready_count=$((ready_count + 1))
        else
            status=$(printf '%b' "${RED}not set${NC}")
        fi

        printf "  %-15s %-30s %b\n" "$cloud" "$env_var" "$status"
    done

    printf '\n'
    local total_count
    total_count=$(echo "$ALL_RECORDABLE_CLOUDS" | wc -w | tr -d ' ')
    printf '%b\n' "  ${ready_count}/${total_count} clouds have credentials set"
    printf '\n'
    printf "  CLI-based clouds (not recordable): sprite, gcp, codesandbox, e2b, modal, fly, daytona, northflank, runpod, vastai, koyeb\n"
}

# --- Main ---
printf '%b\n' "${CYAN}===============================${NC}"
printf '%b\n' "${CYAN} Spawn API Response Recorder${NC}"
printf '%b\n' "${CYAN}===============================${NC}"
printf '\n'

if [[ $# -eq 0 ]]; then
    printf "Usage:\n"
    printf "  bash test/record.sh CLOUD [CLOUD...]   Record fixtures for specified clouds\n"
    printf "  bash test/record.sh all                Record all clouds (prompts for missing keys)\n"
    printf "  bash test/record.sh allsaved           Record clouds that already have keys saved\n"
    printf "  bash test/record.sh --list             Show recordable clouds\n"
    printf '\n'
    exit 0
fi

case "$1" in
    --list|-l)
        list_clouds
        exit 0
        ;;
    --help|-h)
        printf "Usage:\n"
        printf "  bash test/record.sh CLOUD [CLOUD...]   Record fixtures for specified clouds\n"
        printf "  bash test/record.sh all                Record all clouds with credentials\n"
        printf "  bash test/record.sh --list             Show recordable clouds\n"
        printf '\n'
        exit 0
        ;;
esac

# Determine which clouds to record
CLOUDS_TO_RECORD=""
if [[ "$1" == "all" ]]; then
    CLOUDS_TO_RECORD="$ALL_RECORDABLE_CLOUDS"
elif [[ "$1" == "allsaved" ]]; then
    PROMPT_FOR_CREDS=false
    CLOUDS_TO_RECORD="$ALL_RECORDABLE_CLOUDS"
else
    CLOUDS_TO_RECORD="$*"
fi

# Validate cloud names
for cloud in $CLOUDS_TO_RECORD; do
    if ! echo "$ALL_RECORDABLE_CLOUDS" | grep -qw "$cloud"; then
        printf '%b\n' "${RED}Unknown cloud: ${cloud}${NC}"
        printf "Recordable clouds: %s\n" "$ALL_RECORDABLE_CLOUDS"
        exit 1
    fi
done

printf "Fixtures dir: %s\n" "$FIXTURES_DIR"
printf "Clouds:       %s\n" "$CLOUDS_TO_RECORD"
printf '\n'

mkdir -p "$FIXTURES_DIR"

# --- Run clouds in parallel ---
RECORD_RESULTS_DIR=$(mktemp -d)
RECORD_PIDS=""

for cloud in $CLOUDS_TO_RECORD; do
    (
        # Reset counters for this cloud (subshell isolation)
        RECORDED=0
        SKIPPED=0
        ERRORS=0
        record_cloud "$cloud"
        printf '%d %d %d\n' "$RECORDED" "$SKIPPED" "$ERRORS" > "${RECORD_RESULTS_DIR}/${cloud}.counts"
    ) > "${RECORD_RESULTS_DIR}/${cloud}.log" 2>&1 &
    RECORD_PIDS="${RECORD_PIDS} $!"
done

# Wait for all clouds to finish
for pid in $RECORD_PIDS; do
    wait "$pid" 2>/dev/null || true
done

# Print output from each cloud (in order)
for cloud in $CLOUDS_TO_RECORD; do
    if [[ -f "${RECORD_RESULTS_DIR}/${cloud}.log" ]]; then
        cat "${RECORD_RESULTS_DIR}/${cloud}.log"
    fi
done

# Aggregate results
for cloud in $CLOUDS_TO_RECORD; do
    if [[ -f "${RECORD_RESULTS_DIR}/${cloud}.counts" ]]; then
        read -r r s e < "${RECORD_RESULTS_DIR}/${cloud}.counts"
        RECORDED=$((RECORDED + r))
        SKIPPED=$((SKIPPED + s))
        ERRORS=$((ERRORS + e))
    fi
done

rm -rf "${RECORD_RESULTS_DIR}"

# --- Summary ---
printf '%b\n' "${CYAN}===============================${NC}"
TOTAL=$((RECORDED + SKIPPED + ERRORS))
printf '%b\n' " Results: ${GREEN}${RECORDED} recorded${NC}, ${YELLOW}${SKIPPED} skipped${NC}, ${RED}${ERRORS} failed${NC}"
printf '%b\n' "${CYAN}===============================${NC}"

if [[ "$ERRORS" -gt 0 ]]; then
    exit 1
fi
exit 0
