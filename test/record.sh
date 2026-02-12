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
ALL_RECORDABLE_CLOUDS="hetzner digitalocean vultr linode lambda civo upcloud binarylane ovh scaleway genesiscloud kamatera latitude hyperstack"

# --- Endpoint registry ---
# Format: "fixture_name:endpoint"
get_endpoints() {
    local cloud="$1"
    case "$cloud" in
        hetzner)
            printf '%s\n' \
                "server_types:/server_types?per_page=50" \
                "locations:/locations" \
                "ssh_keys:/ssh_keys" \
                "servers:/servers"
            ;;
        digitalocean)
            printf '%s\n' \
                "account:/account" \
                "ssh_keys:/account/keys" \
                "droplets:/droplets" \
                "sizes:/sizes" \
                "regions:/regions"
            ;;
        vultr)
            printf '%s\n' \
                "account:/account" \
                "ssh_keys:/ssh-keys" \
                "instances:/instances" \
                "plans:/plans" \
                "regions:/regions"
            ;;
        linode)
            printf '%s\n' \
                "profile:/profile" \
                "ssh_keys:/profile/sshkeys" \
                "instances:/linode/instances" \
                "types:/linode/types" \
                "regions:/regions"
            ;;
        lambda)
            printf '%s\n' \
                "instances:/instances" \
                "ssh_keys:/ssh-keys" \
                "instance_types:/instance-types"
            ;;
        civo)
            printf '%s\n' \
                "regions:/regions" \
                "instances:/instances" \
                "sshkeys:/sshkeys" \
                "networks:/networks" \
                "disk_images:/disk_images"
            ;;
        upcloud)
            printf '%s\n' \
                "servers:/server" \
                "server_sizes:/server_size"
            ;;
        binarylane)
            printf '%s\n' \
                "sizes:/sizes" \
                "regions:/regions" \
                "servers:/servers"
            ;;
        ovh)
            printf '%s\n' \
                "flavors:/cloud/project/${OVH_PROJECT_ID:-MISSING}/flavor" \
                "images:/cloud/project/${OVH_PROJECT_ID:-MISSING}/image" \
                "ssh_keys:/cloud/project/${OVH_PROJECT_ID:-MISSING}/sshkey"
            ;;
        scaleway)
            printf '%s\n' \
                "servers:/servers" \
                "images:/images?per_page=10"
            ;;
        genesiscloud)
            printf '%s\n' \
                "ssh_keys:/ssh-keys" \
                "instances:/instances"
            ;;
        kamatera)
            printf '%s\n' \
                "server_options:/service/server"
            ;;
        latitude)
            printf '%s\n' \
                "ssh_keys:/ssh_keys" \
                "plans:/plans" \
                "regions:/regions"
            ;;
        hyperstack)
            printf '%s\n' \
                "flavors:/core/flavors" \
                "ssh_keys:/core/keypairs"
            ;;
    esac
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

    # Map cloud name to config file
    local config_file="$HOME/.config/spawn/${cloud}.json"

    # OVH uses separate config with multiple fields
    if [[ "$cloud" == "ovh" ]]; then
        if [[ -f "$config_file" ]]; then
            eval "$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for k, e in [('application_key','OVH_APPLICATION_KEY'), ('application_secret','OVH_APPLICATION_SECRET'),
                 ('consumer_key','OVH_CONSUMER_KEY'), ('project_id','OVH_PROJECT_ID')]:
        v = d.get(k, '')
        if v: print(f'export {e}=\"{v}\"')
except: pass
" "$config_file" 2>/dev/null)" || true
        fi
        return 0
    fi

    # Standard single-token config
    if [[ -f "$config_file" ]]; then
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

    case "$cloud" in
        upcloud)
            [[ -n "${UPCLOUD_USERNAME:-}" ]] && [[ -n "${UPCLOUD_PASSWORD:-}" ]]
            ;;
        ovh)
            [[ -n "${OVH_APPLICATION_KEY:-}" ]] && [[ -n "${OVH_APPLICATION_SECRET:-}" ]] && \
            [[ -n "${OVH_CONSUMER_KEY:-}" ]] && [[ -n "${OVH_PROJECT_ID:-}" ]]
            ;;
        kamatera)
            [[ -n "${KAMATERA_API_CLIENT_ID:-}" ]] && [[ -n "${KAMATERA_API_SECRET:-}" ]]
            ;;
        *)
            local env_var
            env_var=$(get_auth_env_var "$cloud")
            eval "[[ -n \"\${${env_var}:-}\" ]]"
            ;;
    esac
}

# Save credentials to ~/.config/spawn/{cloud}.json for future use
save_config() {
    local cloud="$1"
    local config_dir="$HOME/.config/spawn"
    local config_file="${config_dir}/${cloud}.json"
    mkdir -p "$config_dir"

    case "$cloud" in
        ovh)
            python3 -c "
import json
d = {'application_key': '${OVH_APPLICATION_KEY:-}', 'application_secret': '${OVH_APPLICATION_SECRET:-}',
     'consumer_key': '${OVH_CONSUMER_KEY:-}', 'project_id': '${OVH_PROJECT_ID:-}'}
print(json.dumps(d, indent=2))
" > "$config_file"
            ;;
        upcloud)
            python3 -c "
import json
print(json.dumps({'username': '${UPCLOUD_USERNAME:-}', 'password': '${UPCLOUD_PASSWORD:-}'}, indent=2))
" > "$config_file"
            ;;
        kamatera)
            python3 -c "
import json
print(json.dumps({'client_id': '${KAMATERA_API_CLIENT_ID:-}', 'secret': '${KAMATERA_API_SECRET:-}'}, indent=2))
" > "$config_file"
            ;;
        *)
            local env_var
            env_var=$(get_auth_env_var "$cloud")
            eval "local val=\"\${${env_var}:-}\""
            python3 -c "import json; print(json.dumps({'api_key': '${val}'}, indent=2))" > "$config_file"
            ;;
    esac
    printf '%b\n' "  ${GREEN}saved${NC} → ${config_file}"
}

# Prompt user for missing credentials, export them, and save to config
prompt_credentials() {
    local cloud="$1"
    local vars_needed=""
    local val=""

    case "$cloud" in
        ovh)
            vars_needed="OVH_APPLICATION_KEY OVH_APPLICATION_SECRET OVH_CONSUMER_KEY OVH_PROJECT_ID"
            ;;
        upcloud)
            vars_needed="UPCLOUD_USERNAME UPCLOUD_PASSWORD"
            ;;
        kamatera)
            vars_needed="KAMATERA_API_CLIENT_ID KAMATERA_API_SECRET"
            ;;
        *)
            vars_needed=$(get_auth_env_var "$cloud")
            ;;
    esac

    for var_name in $vars_needed; do
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
    esac
}

# --- Validation ---
is_valid_json() {
    python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null
}

has_api_error() {
    local cloud="$1"
    local response="$2"

    echo "$response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
cloud = '$cloud'

if cloud == 'hetzner':
    err = d.get('error')
    sys.exit(0 if err and isinstance(err, dict) else 1)
elif cloud == 'digitalocean':
    sys.exit(0 if 'id' in d and isinstance(d.get('id'), str) and 'message' in d else 1)
elif cloud in ('vultr', 'genesiscloud', 'hyperstack'):
    sys.exit(0 if 'error' in d and d['error'] else 1)
elif cloud == 'linode':
    sys.exit(0 if 'errors' in d and d['errors'] else 1)
elif cloud in ('ovh', 'scaleway', 'binarylane'):
    # These use 'message' for errors, but some success responses also have 'message'
    sys.exit(0 if 'message' in d and len(d) <= 3 and not any(k in d for k in ('servers','images','ssh_keys','flavors','sizes','regions')) else 1)
elif cloud == 'civo':
    sys.exit(0 if 'reason' in d and 'result' in d and d['result'] == 'failed' else 1)
elif cloud == 'lambda':
    err = d.get('error')
    sys.exit(0 if err and isinstance(err, dict) else 1)
elif cloud == 'kamatera':
    sys.exit(0 if d.get('status') == 'error' else 1)
elif cloud == 'latitude':
    sys.exit(0 if 'error' in d or ('errors' in d and d['errors']) else 1)
else:
    sys.exit(1)
" 2>/dev/null
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

_live_hetzner() {
    local fixture_dir="$1"
    local server_name="spawn-record-$(date +%s)"
    local server_type="cx23"
    local location="nbg1"
    local image="ubuntu-24.04"

    printf '%b\n' "  ${CYAN}live${NC} Creating test server '${server_name}' (${server_type}, ${location})..."

    # Get SSH key IDs for the create request
    local ssh_keys_response
    ssh_keys_response=$(hetzner_api GET "/ssh_keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ids = [k['id'] for k in d.get('ssh_keys', [])]
print(json.dumps(ids))
" 2>/dev/null) || ssh_key_ids="[]"

    # Create server (minimal — no cloud-init userdata to speed up)
    local body
    body=$(python3 -c "
import json
body = {
    'name': '${server_name}',
    'server_type': '${server_type}',
    'location': '${location}',
    'image': '${image}',
    'ssh_keys': ${ssh_key_ids},
    'start_after_create': True
}
print(json.dumps(body))
")

    local create_response
    create_response=$(hetzner_api POST "/servers" "$body")

    # Save create response
    _save_live_fixture "$fixture_dir" "create_server" "POST /servers" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create server — skipping delete fixture"
        return 0
    }

    # Extract server ID for deletion
    local server_id
    server_id=$(echo "$create_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['server']['id'])" 2>/dev/null) || true

    if [[ -z "${server_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract server ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Server created (ID: ${server_id}). Deleting..."

    # Brief pause to let the server register
    sleep 2

    # Delete server
    local delete_response
    delete_response=$(hetzner_api DELETE "/servers/${server_id}")

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE /servers/{id}" "$delete_response"

    printf '%b\n' "  ${CYAN}live${NC} Server ${server_id} deleted"
}

_live_digitalocean() {
    local fixture_dir="$1"
    local droplet_name="spawn-record-$(date +%s)"
    local region="nyc3"
    local size="s-1vcpu-512mb-10gb"
    local image="ubuntu-24-04-x64"

    printf '%b\n' "  ${CYAN}live${NC} Creating test droplet '${droplet_name}' (${size}, ${region})..."

    # Get SSH key IDs
    local ssh_keys_response
    ssh_keys_response=$(do_api GET "/account/keys")
    local ssh_key_ids
    ssh_key_ids=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ids = [k['id'] for k in d.get('ssh_keys', [])]
print(json.dumps(ids))
" 2>/dev/null) || ssh_key_ids="[]"

    local body
    body=$(python3 -c "
import json
body = {
    'name': '${droplet_name}',
    'region': '${region}',
    'size': '${size}',
    'image': '${image}',
    'ssh_keys': ${ssh_key_ids}
}
print(json.dumps(body))
")

    local create_response
    create_response=$(do_api POST "/droplets" "$body")

    _save_live_fixture "$fixture_dir" "create_server" "POST /droplets" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create droplet — skipping delete fixture"
        return 0
    }

    local droplet_id
    droplet_id=$(echo "$create_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['droplet']['id'])" 2>/dev/null) || true

    if [[ -z "${droplet_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract droplet ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Droplet created (ID: ${droplet_id}). Deleting..."
    sleep 3

    local delete_response
    delete_response=$(do_api DELETE "/droplets/${droplet_id}")

    # DigitalOcean DELETE returns 204 No Content (empty body) on success
    if [[ -z "$delete_response" ]]; then
        delete_response='{"status":"deleted","http_code":204}'
    fi

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE /droplets/{id}" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Droplet ${droplet_id} deleted"
}

_live_vultr() {
    local fixture_dir="$1"
    local label="spawn-record-$(date +%s)"
    local region="ewr"
    local plan="vc2-1c-1gb"
    local os_id="2284"  # Ubuntu 24.04

    printf '%b\n' "  ${CYAN}live${NC} Creating test instance '${label}' (${plan}, ${region})..."

    # Get SSH key ID
    local ssh_keys_response
    ssh_keys_response=$(vultr_api GET "/ssh-keys")
    local ssh_key_id
    ssh_key_id=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
keys = d.get('ssh_keys', [])
print(keys[0]['id'] if keys else '')
" 2>/dev/null) || ssh_key_id=""

    local body
    body=$(python3 -c "
import json
body = {
    'label': '${label}',
    'region': '${region}',
    'plan': '${plan}',
    'os_id': ${os_id}
}
if '${ssh_key_id}':
    body['sshkey_id'] = ['${ssh_key_id}']
print(json.dumps(body))
")

    local create_response
    create_response=$(vultr_api POST "/instances" "$body")

    _save_live_fixture "$fixture_dir" "create_server" "POST /instances" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create instance — skipping delete fixture"
        return 0
    }

    local instance_id
    instance_id=$(echo "$create_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['instance']['id'])" 2>/dev/null) || true

    if [[ -z "${instance_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract instance ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Instance created (ID: ${instance_id}). Deleting..."
    sleep 5

    local delete_response
    delete_response=$(vultr_api DELETE "/instances/${instance_id}")

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE /instances/{id}" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Instance ${instance_id} deleted"
}

_live_linode() {
    local fixture_dir="$1"
    local label="spawn-record-$(date +%s)"
    local region="us-east"
    local linode_type="g6-nanode-1"
    local image="linode/ubuntu24.04"

    printf '%b\n' "  ${CYAN}live${NC} Creating test linode '${label}' (${linode_type}, ${region})..."

    # Get SSH keys for authorized_keys
    local ssh_keys_response
    ssh_keys_response=$(linode_api GET "/profile/sshkeys")
    local ssh_keys_json
    ssh_keys_json=$(echo "$ssh_keys_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
keys = [k['ssh_key'] for k in d.get('data', [])]
print(json.dumps(keys))
" 2>/dev/null) || ssh_keys_json="[]"

    # Generate a random root password
    local root_pass
    root_pass=$(python3 -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits+'!@#') for _ in range(24)))")

    local body
    body=$(python3 -c "
import json
body = {
    'label': '${label}',
    'region': '${region}',
    'type': '${linode_type}',
    'image': '${image}',
    'root_pass': '${root_pass}',
    'authorized_keys': ${ssh_keys_json}
}
print(json.dumps(body))
")

    local create_response
    create_response=$(linode_api POST "/linode/instances" "$body")

    _save_live_fixture "$fixture_dir" "create_server" "POST /linode/instances" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create linode — skipping delete fixture"
        return 0
    }

    local linode_id
    linode_id=$(echo "$create_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])" 2>/dev/null) || true

    if [[ -z "${linode_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract linode ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Linode created (ID: ${linode_id}). Deleting..."
    sleep 3

    local delete_response
    delete_response=$(linode_api DELETE "/linode/instances/${linode_id}")

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE /linode/instances/{id}" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Linode ${linode_id} deleted"
}

_live_civo() {
    local fixture_dir="$1"
    local hostname="spawn-record-$(date +%s)"
    local size="g3.xsmall"
    local region="nyc1"

    printf '%b\n' "  ${CYAN}live${NC} Creating test instance '${hostname}' (${size}, ${region})..."

    # Get default network ID
    local networks_response
    networks_response=$(civo_api GET "/networks")
    local network_id
    network_id=$(echo "$networks_response" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
nets = d if isinstance(d, list) else d.get('items', d.get('networks', []))
for n in nets:
    if n.get('default', False):
        print(n['id'])
        break
else:
    if nets:
        print(nets[0]['id'])
" 2>/dev/null) || network_id=""

    # Get Ubuntu disk image template
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
        print(img['id'])
        break
else:
    if imgs:
        print(imgs[0]['id'])
" 2>/dev/null) || template_id=""

    local body
    body=$(python3 -c "
import json
body = {
    'hostname': '${hostname}',
    'size': '${size}',
    'region': '${region}'
}
if '${network_id}':
    body['network_id'] = '${network_id}'
if '${template_id}':
    body['template_id'] = '${template_id}'
print(json.dumps(body))
")

    local create_response
    create_response=$(civo_api POST "/instances" "$body")

    _save_live_fixture "$fixture_dir" "create_server" "POST /instances" "$create_response" || {
        printf '%b\n' "  ${RED}fail${NC} Could not create instance — skipping delete fixture"
        return 0
    }

    local instance_id
    instance_id=$(echo "$create_response" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['id'])" 2>/dev/null) || true

    if [[ -z "${instance_id:-}" ]]; then
        printf '%b\n' "  ${RED}fail${NC} Could not extract instance ID from create response"
        cloud_errors=$((cloud_errors + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}live${NC} Instance created (ID: ${instance_id}). Deleting..."
    sleep 3

    local delete_response
    delete_response=$(civo_api DELETE "/instances/${instance_id}")

    _save_live_fixture "$fixture_dir" "delete_server" "DELETE /instances/{id}" "$delete_response"
    printf '%b\n' "  ${CYAN}live${NC} Instance ${instance_id} deleted"
}

# --- Ensure credentials are available for a cloud, prompting if needed ---
# Returns 0 if credentials are available, 1 if skipped
_ensure_cloud_credentials() {
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

# --- Record a single endpoint fixture via subshell API call ---
# Updates cloud_recorded, cloud_errors, metadata_entries in caller scope
_record_endpoint() {
    local cloud="$1" fixture_dir="$2" fixture_name="$3" endpoint="$4"

    local tmp_response
    tmp_response=$(mktemp /tmp/spawn-record-XXXXXX)

    (
        source "${REPO_ROOT}/${cloud}/lib/common.sh" 2>/dev/null
        call_api "$cloud" "$endpoint" 2>/dev/null
    ) > "$tmp_response" 2>/dev/null || true

    local response
    response=$(cat "$tmp_response")
    rm -f "$tmp_response"

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

    echo "$response" | pretty_json > "${fixture_dir}/${fixture_name}.json"
    printf '%b\n' "  ${GREEN}  ok${NC} ${fixture_name} → fixtures/${cloud}/${fixture_name}.json"
    cloud_recorded=$((cloud_recorded + 1))

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    metadata_entries="${metadata_entries}    \"${fixture_name}\": {\"endpoint\": \"${endpoint}\", \"recorded_at\": \"${timestamp}\"},
"
}

# --- Write metadata JSON for recorded fixtures ---
_write_fixture_metadata() {
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

# --- Record one cloud ---
record_cloud() {
    local cloud="$1"

    _ensure_cloud_credentials "$cloud" || return 0

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
        _record_endpoint "$cloud" "$fixture_dir" "$fixture_name" "$endpoint" || true
    done <<< "$endpoints"

    # Live create+delete cycle for write endpoint fixtures
    _record_live_cycle "$cloud" "$fixture_dir" cloud_recorded cloud_errors metadata_entries || true

    _write_fixture_metadata "$cloud" "$fixture_dir"

    RECORDED=$((RECORDED + cloud_recorded))
    ERRORS=$((ERRORS + cloud_errors))

    if [[ "$cloud_errors" -eq 0 ]]; then
        printf '%b\n' "  ${GREEN}done${NC} ${cloud_recorded} fixtures recorded"
    else
        printf '%b\n' "  ${YELLOW}done${NC} ${cloud_recorded} recorded, ${cloud_errors} failed"
    fi
    printf '\n'
}

# --- List mode ---
list_clouds() {
    printf '%b\n' "${CYAN}Recordable clouds:${NC}"
    printf '\n'
    printf "  %-15s %-30s %s\n" "CLOUD" "AUTH ENV VAR" "STATUS"
    printf "  %-15s %-30s %s\n" "-----" "------------" "------"

    for cloud in $ALL_RECORDABLE_CLOUDS; do
        local env_var
        env_var=$(get_auth_env_var "$cloud")
        local status

        if has_credentials "$cloud"; then
            status=$(printf '%b' "${GREEN}ready${NC}")
        else
            status=$(printf '%b' "${RED}not set${NC}")
        fi

        # For multi-var clouds, show all required vars
        case "$cloud" in
            upcloud)    env_var="UPCLOUD_USERNAME + UPCLOUD_PASSWORD" ;;
            ovh)        env_var="OVH_APPLICATION_KEY + 3 more" ;;
            kamatera)   env_var="KAMATERA_API_CLIENT_ID + SECRET" ;;
        esac

        printf "  %-15s %-30s %b\n" "$cloud" "$env_var" "$status"
    done

    printf '\n'
    local ready_count=0
    for cloud in $ALL_RECORDABLE_CLOUDS; do
        if has_credentials "$cloud"; then
            ready_count=$((ready_count + 1))
        fi
    done

    local total_count
    total_count=$(echo "$ALL_RECORDABLE_CLOUDS" | wc -w | tr -d ' ')
    printf '%b\n' "  ${ready_count}/${total_count} clouds have credentials set"
    printf '\n'
    printf "  CLI-based clouds (not recordable): sprite, gcp, e2b, modal, fly, daytona, northflank, runpod, vastai, koyeb\n"
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

for cloud in $CLOUDS_TO_RECORD; do
    record_cloud "$cloud"
done

# --- Summary ---
printf '%b\n' "${CYAN}===============================${NC}"
TOTAL=$((RECORDED + SKIPPED + ERRORS))
printf '%b\n' " Results: ${GREEN}${RECORDED} recorded${NC}, ${YELLOW}${SKIPPED} skipped${NC}, ${RED}${ERRORS} failed${NC}"
printf '%b\n' "${CYAN}===============================${NC}"

if [[ "$ERRORS" -gt 0 ]]; then
    exit 1
fi
exit 0
