#!/bin/bash
# Fixture-based mock test suite for cloud provider agent scripts
#
# Uses recorded API responses from test/fixtures/{cloud}/ to test
# every agent script without making real API calls.
#
# Usage:
#   bash test/mock.sh                    # Test all clouds with fixtures
#   bash test/mock.sh hetzner            # Test all agents on one cloud
#   bash test/mock.sh hetzner claude     # Test one agent on one cloud

set -eo pipefail

if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
    printf 'WARNING: bash %s detected. Some features may need bash 4+.\n' "${BASH_VERSION}" >&2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES_DIR="${REPO_ROOT}/test/fixtures"
TEST_DIR=$(mktemp -d)
MOCK_LOG="${TEST_DIR}/mock_calls.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Cleanup on exit
cleanup() {
    rm -rf "${TEST_DIR}"
}
trap cleanup EXIT

# ============================================================
# Assertions (same pattern as test/run.sh)
# ============================================================

assert_exit_code() {
    local actual="$1"
    local expected="$2"
    local msg="$3"
    if [[ "${actual}" -eq "${expected}" ]]; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg} (got exit code ${actual})"
        FAILED=$((FAILED + 1))
    fi
}

assert_log_contains() {
    local pattern="$1"
    local msg="$2"
    if grep -qE "${pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_api_called() {
    local method="$1"
    local endpoint_pattern="$2"
    local msg="${3:-calls ${method} ${endpoint_pattern}}"
    if grep -qE "curl ${method} .*${endpoint_pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_env_injected() {
    local var_name="$1"
    local msg="${2:-injects ${var_name}}"
    # Check mock log (ssh/scp commands may reference the var) and output log.
    # Also check case-insensitively: OPENROUTER_API_KEY → "openrouter" appears
    # in output like "Using OpenRouter API key from environment".
    local first_word
    first_word=$(printf '%s' "$var_name" | sed 's/_.*//' | tr '[:upper:]' '[:lower:]')
    if grep -qE "${var_name}" "${MOCK_LOG}" 2>/dev/null || \
       grep -qE "${var_name}" "${TEST_DIR}/output.log" 2>/dev/null || \
       grep -qi "${first_word}" "${TEST_DIR}/output.log" 2>/dev/null || \
       grep -qi "${first_word}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_file_created() {
    local path_pattern="$1"
    local msg="${2:-creates file matching ${path_pattern}}"
    if grep -qE "(scp|upload|file).*${path_pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_no_body_errors() {
    local msg="${1:-no request body validation errors}"
    if grep -qE "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null; then
        local errors
        errors=$(grep "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null)
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        printf '%b\n' "    ${RED}  Errors:${NC}"
        printf '%s\n' "$errors" | while IFS= read -r line; do
            printf '      %s\n' "$line"
        done
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    fi
}

assert_server_cleaned_up() {
    local state_file="$1"
    local msg="${2:-server lifecycle tracked}"
    if [[ ! -f "$state_file" ]]; then
        printf '%b\n' "    ${YELLOW}⚠${NC} ${msg} (no state file)"
        return 0
    fi
    local created deleted
    created=$(grep -c "^CREATED:" "$state_file" 2>/dev/null || true)
    deleted=$(grep -c "^DELETED:" "$state_file" 2>/dev/null || true)
    if [[ "$created" -gt 0 ]]; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg} (created=${created}, deleted=${deleted})"
        PASSED=$((PASSED + 1))
        if [[ "$deleted" -lt "$created" ]]; then
            printf '%b\n' "    ${YELLOW}⚠${NC} warning: ${created} created but only ${deleted} deleted (expected — user takes over)"
        fi
    else
        printf '%b\n' "    ${YELLOW}⚠${NC} ${msg} (no server creation tracked)"
    fi
}

# ============================================================
# Mock setup
# ============================================================

setup_mock_curl() {
    cat > "${TEST_DIR}/curl" << 'MOCKCURL'
#!/bin/bash
# Mock curl — returns fixture data based on URL
# Env vars from parent: MOCK_LOG, MOCK_FIXTURE_DIR, MOCK_CLOUD

# --- Helper functions ---

_parse_curl_args() {
    METHOD="GET"
    URL=""
    BODY=""
    HAS_WRITE_OUT=false
    local prev_flag=""
    for arg in "$@"; do
        case "$prev_flag" in
            -X) METHOD="$arg"; prev_flag=""; continue ;;
            -w)
                case "$arg" in *http_code*) HAS_WRITE_OUT=true ;; esac
                prev_flag=""; continue ;;
            -d) BODY="$arg"; prev_flag=""; continue ;;
            -H|-o|-u|--connect-timeout|--max-time|--retry|--retry-delay) prev_flag=""; continue ;;
        esac
        case "$arg" in
            -X|-w|-d|-H|-o|-u|--connect-timeout|--max-time|--retry|--retry-delay) prev_flag="$arg"; continue ;;
            -s|-f|-S|-L|-k|-#|-fsSL|-fsS|-sS) continue ;;
            http://*|https://*) URL="$arg" ;;
        esac
    done
}

_emit_error() {
    local msg="$1" code="$2"
    printf '%s' "$msg"
    if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n%s' "$code"; fi
    exit 1
}

_try_error_injection() {
    [ -n "${MOCK_ERROR_SCENARIO:-}" ] || return 1
    case "$URL" in
        *openrouter.ai*|*raw.githubusercontent.com*|*claude.ai/install*|*bun.sh*|*goose*|*nodesource*|*plandex.ai*|*opencode*|*pip.pypa.io*|*get.docker.com*|*npmjs.org*|*github.com/*/releases*)
            return 1 ;;
    esac
    case "${MOCK_ERROR_SCENARIO}" in
        auth_failure)   _emit_error '{"error":"Unauthorized"}' 401 ;;
        rate_limit)     _emit_error '{"error":"Rate limit exceeded"}' 429 ;;
        server_error)   _emit_error '{"error":"Internal server error"}' 500 ;;
        create_failure)
            if [ "$METHOD" = "POST" ]; then
                case "$URL" in
                    *servers*|*droplets*|*instances*) _emit_error '{"error":"Unprocessable entity"}' 422 ;;
                esac
            fi ;;
    esac
    return 1
}

_handle_well_known_urls() {
    case "$URL" in
        *claude.ai/install*|*bun.sh*|*goose*download_cli*|*nodesource*|*plandex.ai*|*opencode*install*|\
        *pip.pypa.io*|*get.docker.com*|*raw.githubusercontent.com/block/goose*|*install.python-poetry.org*|\
        *npmjs.org*|*deb.nodesource.com*|*github.com/*/releases*|*cli.github.com*)
            printf '#!/bin/bash\nexit 0\n'
            exit 0 ;;
        *raw.githubusercontent.com/OpenRouterTeam/spawn/*)
            local local_path="${MOCK_REPO_ROOT}/${URL##*spawn/main/}"
            if [ -f "$local_path" ]; then cat "$local_path"; fi
            exit 0 ;;
        *openrouter.ai*)
            printf '{"key":"sk-or-v1-mock"}\n'
            if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n200'; fi
            exit 0 ;;
    esac
}

_strip_api_base() {
    ENDPOINT="$URL"
    case "$URL" in
        https://api.hetzner.cloud/v1*)                  ENDPOINT="${URL#https://api.hetzner.cloud/v1}" ;;
        https://api.digitalocean.com/v2*)                ENDPOINT="${URL#https://api.digitalocean.com/v2}" ;;
        https://api.vultr.com/v2*)                       ENDPOINT="${URL#https://api.vultr.com/v2}" ;;
        https://api.linode.com/v4*)                      ENDPOINT="${URL#https://api.linode.com/v4}" ;;
        https://cloud.lambdalabs.com/api/v1*)            ENDPOINT="${URL#https://cloud.lambdalabs.com/api/v1}" ;;
        https://api.civo.com/v2*)                        ENDPOINT="${URL#https://api.civo.com/v2}" ;;
        https://api.upcloud.com/1.3*)                    ENDPOINT="${URL#https://api.upcloud.com/1.3}" ;;
        https://api.binarylane.com.au/v2*)               ENDPOINT="${URL#https://api.binarylane.com.au/v2}" ;;
        https://api.scaleway.com/*)                      ENDPOINT=$(echo "$URL" | sed 's|https://api.scaleway.com/instance/v1/zones/[^/]*/||') ;;
        https://api.genesiscloud.com/compute/v1*)        ENDPOINT="${URL#https://api.genesiscloud.com/compute/v1}" ;;
        https://console.kamatera.com/svc*)               ENDPOINT="${URL#https://console.kamatera.com/svc}" ;;
        https://api.latitude.sh*)                        ENDPOINT="${URL#https://api.latitude.sh}" ;;
        https://infrahub-api.nexgencloud.com/v1*)        ENDPOINT="${URL#https://infrahub-api.nexgencloud.com/v1}" ;;
        *eu.api.ovh.com*)                                ENDPOINT=$(echo "$URL" | sed 's|https://eu.api.ovh.com/1.0||') ;;
    esac
    EP_CLEAN=$(echo "$ENDPOINT" | sed 's|?.*||')
}

_check_fields() {
    local fields="$1"
    for field in $fields; do
        if ! printf '%s' "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert '$field' in d" 2>/dev/null; then
            echo "BODY_ERROR:missing_field:${field}:${URL}" >> "${MOCK_LOG}"
        fi
    done
}

_validate_request_body() {
    [ "${MOCK_VALIDATE_BODY:-}" = "1" ] && [ -n "$BODY" ] && [ "$METHOD" = "POST" ] || return 0
    if ! printf '%s' "$BODY" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${URL}" >> "${MOCK_LOG}"
        return 0
    fi
    case "${MOCK_CLOUD}" in
        hetzner)      case "$EP_CLEAN" in /servers)           _check_fields "name server_type image location" ;; esac ;;
        digitalocean) case "$EP_CLEAN" in /droplets)          _check_fields "name region size image" ;; esac ;;
        vultr)        case "$EP_CLEAN" in /instances)         _check_fields "label region plan os_id" ;; esac ;;
        linode)       case "$EP_CLEAN" in /linode/instances)  _check_fields "label region type image" ;; esac ;;
        civo)         case "$EP_CLEAN" in /instances)         _check_fields "hostname size region" ;; esac ;;
    esac
}

_try_fixture() {
    local f="${MOCK_FIXTURE_DIR}/$1.json"
    if [ -f "$f" ]; then cat "$f"; return 0; fi
    return 1
}

_synthetic_resource_response() {
    case "$MOCK_CLOUD" in
        hetzner)      printf '{"server":{"id":99999,"name":"test-srv","status":"running","public_net":{"ipv4":{"ip":"10.0.0.1"}}}}' ;;
        digitalocean) printf '{"droplet":{"id":12345678,"name":"test-srv","status":"active","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}' ;;
        vultr)        printf '{"instance":{"id":"test-uuid-1234","main_ip":"10.0.0.1","status":"active","power_status":"running","label":"test-srv"}}' ;;
        linode)       printf '{"id":12345678,"label":"test-srv","status":"running","ipv4":["10.0.0.1"]}' ;;
        lambda)       printf '{"data":{"id":"test-uuid-1234","name":"test-srv","status":"active","ip":"10.0.0.1"}}' ;;
        *)            printf '{}' ;;
    esac
}

_handle_get() {
    local fixture_name
    fixture_name=$(echo "$EP_CLEAN" | sed 's|^/||; s|/|_|g')
    local last_seg
    last_seg=$(echo "$EP_CLEAN" | sed 's|.*/||')
    local has_id=false
    case "$last_seg" in *[0-9]*) has_id=true ;; esac

    if _try_fixture "$fixture_name"; then
        :
    elif [ "$has_id" = "false" ]; then
        local base
        base=$(echo "$fixture_name" | sed 's|_[0-9a-f-]*$||')
        _try_fixture "$base" || printf '{}'
    else
        _synthetic_resource_response
    fi
}

_handle_post() {
    case "$EP_CLEAN" in
        /ssh_keys|/ssh-keys|/account/keys|/profile/sshkeys|/sshkeys|*/sshkey)
            printf '{"ssh_key":{"id":99999,"name":"test-key","fingerprint":"af:0d:c5:57:a8:fd:b2:82:5e:d4:c1:65:f0:0c:8a:9d"}}'
            ;;
        *)
            if _try_fixture "create_server"; then
                :
            else
                case "$MOCK_CLOUD" in
                    hetzner)      printf '{"server":{"id":99999,"name":"test-srv","public_net":{"ipv4":{"ip":"10.0.0.1"}}},"action":{"id":1,"status":"running"}}' ;;
                    digitalocean) printf '{"droplet":{"id":12345678,"name":"test-srv","status":"new","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}' ;;
                    vultr)        printf '{"instance":{"id":"test-uuid-1234","main_ip":"10.0.0.1","status":"active","power_status":"running","label":"test-srv"}}' ;;
                    linode)       printf '{"id":12345678,"label":"test-srv","status":"running","ipv4":["10.0.0.1"]}' ;;
                    *)            printf '{"id":"test-id","status":"active","ip":"10.0.0.1"}' ;;
                esac
            fi
            ;;
    esac
}

_track_state() {
    [ "${MOCK_TRACK_STATE:-}" = "1" ] && [ -n "${MOCK_STATE_FILE:-}" ] || return 0
    local ts
    ts=$(date +%s)
    case "$METHOD" in
        POST)
            case "$EP_CLEAN" in
                /servers|/droplets|/instances|/linode/instances|/instance-operations/launch)
                    echo "CREATED:${MOCK_CLOUD}:${ts}" >> "${MOCK_STATE_FILE}" ;;
            esac ;;
        DELETE)
            echo "DELETED:${MOCK_CLOUD}:${ts}" >> "${MOCK_STATE_FILE}" ;;
    esac
}

# --- Main flow ---

_parse_curl_args "$@"

echo "curl ${METHOD} ${URL}" >> "${MOCK_LOG}"
if [ -n "$BODY" ]; then
    echo "BODY:${BODY}" >> "${MOCK_LOG}"
fi

_try_error_injection
_handle_well_known_urls

[ -n "$URL" ] || exit 0

_strip_api_base
_validate_request_body

case "$METHOD" in
    GET)    _handle_get ;;
    POST)   _handle_post ;;
    DELETE) _try_fixture "delete_server" || printf '{}' ;;
    *)      printf '{}' ;;
esac

_track_state

if [ "$HAS_WRITE_OUT" = "true" ]; then
    printf '\n200'
fi

exit 0
MOCKCURL
    chmod +x "${TEST_DIR}/curl"
}

setup_mock_ssh() {
    # Mock ssh — log and succeed
    cat > "${TEST_DIR}/ssh" << 'MOCKSSH'
#!/bin/bash
echo "ssh $*" >> "${MOCK_LOG}"
exit 0
MOCKSSH
    chmod +x "${TEST_DIR}/ssh"

    # Mock scp — log and succeed
    cat > "${TEST_DIR}/scp" << 'MOCKSCP'
#!/bin/bash
echo "scp $*" >> "${MOCK_LOG}"
exit 0
MOCKSCP
    chmod +x "${TEST_DIR}/scp"
}

setup_mock_agents() {
    # Agent binaries
    local agents="claude aider goose codex interpreter gemini amazonq cline gptme opencode plandex kilocode openclaw nanoclaw q"
    for agent in $agents; do
        cat > "${TEST_DIR}/${agent}" << MOCK
#!/bin/bash
echo "${agent} \$*" >> "\${MOCK_LOG}"
exit 0
MOCK
        chmod +x "${TEST_DIR}/${agent}"
    done

    # Tools used during agent install
    local tools="pip pip3 npm npx bun node openssl shred cargo go"
    for tool in $tools; do
        cat > "${TEST_DIR}/${tool}" << MOCK
#!/bin/bash
echo "${tool} \$*" >> "\${MOCK_LOG}"
exit 0
MOCK
        chmod +x "${TEST_DIR}/${tool}"
    done

    # Mock 'clear' to prevent terminal clearing
    cat > "${TEST_DIR}/clear" << 'MOCK'
#!/bin/bash
exit 0
MOCK
    chmod +x "${TEST_DIR}/clear"

    # Mock 'sleep' to speed up tests
    cat > "${TEST_DIR}/sleep" << 'MOCK'
#!/bin/bash
exit 0
MOCK
    chmod +x "${TEST_DIR}/sleep"

    # Mock 'ssh-keygen' — returns MD5 fingerprint matching fixture data
    cat > "${TEST_DIR}/ssh-keygen" << 'MOCK'
#!/bin/bash
echo "ssh-keygen $*" >> "${MOCK_LOG}"
# Check for -l flag (fingerprint listing)
for arg in "$@"; do
    case "$arg" in
        -l*) echo "256 MD5:af:0d:c5:57:a8:fd:b2:82:5e:d4:c1:65:f0:0c:8a:9d test@test (ED25519)"; exit 0 ;;
    esac
done
# Parse -f flag for key creation
KEY_PATH=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-f" ]; then
        KEY_PATH="$arg"
    fi
    prev="$arg"
done
if [ -n "$KEY_PATH" ]; then
    mkdir -p "$(dirname "$KEY_PATH")"
    touch "$KEY_PATH"
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmcVdzydp72a/B69nmENZvCvjuk7xGpKdi5CvhkmNsv test@test" > "${KEY_PATH}.pub"
fi
exit 0
MOCK
    chmod +x "${TEST_DIR}/ssh-keygen"

    # Mock 'git' for agents that clone repos
    cat > "${TEST_DIR}/git" << 'MOCK'
#!/bin/bash
echo "git $*" >> "${MOCK_LOG}"
exit 0
MOCK
    chmod +x "${TEST_DIR}/git"
}

setup_fake_home() {
    local fake_home="${TEST_DIR}/fakehome"
    mkdir -p "${fake_home}/.ssh"
    mkdir -p "${fake_home}/.config/spawn"
    mkdir -p "${fake_home}/.claude"
    mkdir -p "${fake_home}/.local/bin"
    # Create dummy SSH key pair
    echo "-----BEGIN OPENSSH PRIVATE KEY-----" > "${fake_home}/.ssh/id_ed25519"
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmcVdzydp72a/B69nmENZvCvjuk7xGpKdi5CvhkmNsv test@test" > "${fake_home}/.ssh/id_ed25519.pub"
    chmod 600 "${fake_home}/.ssh/id_ed25519"
    echo "${fake_home}"
}

# ============================================================
# Cloud-specific env var setup
# ============================================================

setup_env_for_cloud() {
    local cloud="$1"

    # Universal env vars
    export OPENROUTER_API_KEY="sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000"
    export INSTANCE_STATUS_POLL_DELAY=0

    case "$cloud" in
        hetzner)
            export HCLOUD_TOKEN="test-token-hetzner"
            export HETZNER_SERVER_NAME="test-srv"
            export HETZNER_SERVER_TYPE="cpx11"
            export HETZNER_LOCATION="fsn1"
            ;;
        digitalocean)
            export DO_API_TOKEN="test-token-do"
            export DO_DROPLET_NAME="test-srv"
            export DO_DROPLET_SIZE="s-2vcpu-2gb"
            export DO_REGION="nyc3"
            ;;
        vultr)
            export VULTR_API_KEY="test-token-vultr"
            export VULTR_SERVER_NAME="test-srv"
            export VULTR_PLAN="vc2-1c-2gb"
            export VULTR_REGION="ewr"
            ;;
        linode)
            export LINODE_API_TOKEN="test-token-linode"
            export LINODE_SERVER_NAME="test-srv"
            export LINODE_TYPE="g6-standard-1"
            export LINODE_REGION="us-east"
            ;;
        lambda)
            export LAMBDA_API_KEY="test-token-lambda"
            export LAMBDA_SERVER_NAME="test-srv"
            ;;
        civo)
            export CIVO_API_TOKEN="test-token-civo"
            export CIVO_SERVER_NAME="test-srv"
            export CIVO_REGION="lon1"
            ;;
        upcloud)
            export UPCLOUD_USERNAME="test-user"
            export UPCLOUD_PASSWORD="test-pass"
            export UPCLOUD_SERVER_NAME="test-srv"
            export UPCLOUD_PLAN="1xCPU-1GB"
            export UPCLOUD_ZONE="us-chi1"
            ;;
        binarylane)
            export BINARYLANE_API_TOKEN="test-token-bl"
            export BINARYLANE_SERVER_NAME="test-srv"
            export BINARYLANE_SIZE="std-min"
            export BINARYLANE_REGION="syd"
            ;;
        ovh)
            export OVH_APPLICATION_KEY="test-app-key"
            export OVH_APPLICATION_SECRET="test-app-secret"
            export OVH_CONSUMER_KEY="test-consumer-key"
            export OVH_PROJECT_ID="test-project-id"
            export OVH_SERVER_NAME="test-srv"
            ;;
        scaleway)
            export SCW_SECRET_KEY="test-token-scw"
            export SCALEWAY_SERVER_NAME="test-srv"
            export SCALEWAY_ZONE="fr-par-1"
            ;;
        genesiscloud)
            export GENESIS_API_KEY="test-token-genesis"
            export GENESIS_SERVER_NAME="test-srv"
            ;;
        kamatera)
            export KAMATERA_API_CLIENT_ID="test-client-id"
            export KAMATERA_API_SECRET="test-secret"
            export KAMATERA_SERVER_NAME="test-srv"
            ;;
        latitude)
            export LATITUDE_API_KEY="test-token-lat"
            export LATITUDE_SERVER_NAME="test-srv"
            ;;
        hyperstack)
            export HYPERSTACK_API_KEY="test-token-hyper"
            export HYPERSTACK_SERVER_NAME="test-srv"
            ;;
    esac
}

# ============================================================
# Discovery
# ============================================================

discover_clouds() {
    for fixture_dir in "${FIXTURES_DIR}"/*/; do
        local cloud
        cloud=$(basename "$fixture_dir")
        if [[ -f "${fixture_dir}/_metadata.json" ]]; then
            echo "$cloud"
        fi
    done
}

discover_agents() {
    local cloud="$1"
    for script in "${REPO_ROOT}/${cloud}"/*.sh; do
        [[ -f "$script" ]] || continue
        local agent
        agent=$(basename "$script" .sh)
        echo "$agent"
    done
}

# ============================================================
# Test runner
# ============================================================

run_test() {
    local cloud="$1"
    local agent="$2"
    local script_path="${REPO_ROOT}/${cloud}/${agent}.sh"

    if [[ ! -f "$script_path" ]]; then
        printf '%b\n' "  ${YELLOW}skip${NC} ${cloud}/${agent}.sh — file not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}test${NC} ${cloud}/${agent}.sh"

    # Snapshot failure count before this test's assertions
    local _pre_failed="${FAILED}"

    # Reset mock log
    : > "${MOCK_LOG}"

    # Set up environment
    setup_env_for_cloud "$cloud"

    # Fake HOME to avoid polluting real home
    local fake_home
    fake_home=$(setup_fake_home)

    # Set up state file for state tracking
    local state_file="${TEST_DIR}/state_${cloud}_${agent}.log"
    : > "${state_file}"

    # Run the script with mocked PATH + HOME (10s timeout — all calls are fake)
    local exit_code=0

    MOCK_LOG="${MOCK_LOG}" \
    MOCK_FIXTURE_DIR="${FIXTURES_DIR}/${cloud}" \
    MOCK_CLOUD="${cloud}" \
    MOCK_REPO_ROOT="${REPO_ROOT}" \
    MOCK_VALIDATE_BODY="${MOCK_VALIDATE_BODY:-}" \
    MOCK_TRACK_STATE="${MOCK_TRACK_STATE:-}" \
    MOCK_STATE_FILE="${state_file}" \
    MOCK_ERROR_SCENARIO="${MOCK_ERROR_SCENARIO:-}" \
    PATH="${TEST_DIR}:${PATH}" \
    HOME="${fake_home}" \
        bash "${script_path}" < /dev/null > "${TEST_DIR}/output.log" 2>&1 &
    local pid=$!
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$i" -ge 4 ]]; then
            kill -9 "$pid" 2>/dev/null
            wait "$pid" 2>/dev/null || true
            exit_code=124
            break
        fi
        sleep 1
        i=$((i + 1))
    done
    if [[ "$exit_code" -ne 124 ]]; then
        wait "$pid" 2>/dev/null || exit_code=$?
    fi

    # Show last lines of output on failure
    if [[ "${exit_code}" -ne 0 ]]; then
        printf '%b\n' "    ${RED}--- output (last 20 lines) ---${NC}"
        tail -20 "${TEST_DIR}/output.log" 2>/dev/null | while IFS= read -r line; do
            printf '    %s\n' "$line"
        done
        printf '%b\n' "    ${RED}--- end output ---${NC}"
    fi

    # --- Assertions ---
    if [[ -n "${MOCK_ERROR_SCENARIO:-}" ]]; then
        # Error scenarios: expect non-zero exit
        if [[ "${exit_code}" -ne 0 ]]; then
            printf '%b\n' "    ${GREEN}✓${NC} fails on ${MOCK_ERROR_SCENARIO} (exit code ${exit_code})"
            PASSED=$((PASSED + 1))
            if [[ -n "${RESULTS_FILE:-}" ]]; then
                printf '%s/%s:pass\n' "${cloud}" "${agent}" >> "${RESULTS_FILE}"
            fi
        else
            printf '%b\n' "    ${RED}✗${NC} should fail on ${MOCK_ERROR_SCENARIO} but exited 0"
            FAILED=$((FAILED + 1))
            if [[ -n "${RESULTS_FILE:-}" ]]; then
                printf '%s/%s:fail\n' "${cloud}" "${agent}" >> "${RESULTS_FILE}"
            fi
        fi
        printf '\n'
        return 0
    fi

    assert_exit_code "${exit_code}" 0 "exits successfully"

    # Cloud-specific API call assertions
    case "$cloud" in
        hetzner)
            assert_api_called "GET" "/ssh_keys" "fetches SSH keys"
            assert_api_called "POST" "/servers" "creates server"
            ;;
        digitalocean)
            assert_api_called "GET" "/account/keys" "fetches SSH keys"
            assert_api_called "POST" "/droplets" "creates droplet"
            ;;
        vultr)
            assert_api_called "GET" "/ssh-keys" "fetches SSH keys"
            assert_api_called "POST" "/instances" "creates instance"
            ;;
        linode)
            assert_api_called "GET" "/profile/sshkeys" "fetches SSH keys"
            assert_api_called "POST" "/linode/instances" "creates instance"
            ;;
        civo)
            assert_api_called "GET" "/sshkeys" "fetches SSH keys"
            assert_api_called "POST" "/instances" "creates instance"
            ;;
        lambda)
            assert_api_called "GET" "/ssh-keys" "fetches SSH keys"
            assert_api_called "POST" "/instance-operations/launch" "launches instance"
            ;;
        *)
            assert_log_contains "curl (GET|POST) https://" "makes API calls"
            ;;
    esac

    # Check that SSH was used (for remote execution)
    assert_log_contains "ssh " "uses SSH"

    # Check OpenRouter API key injection
    assert_env_injected "OPENROUTER_API_KEY"

    # Body validation (when enabled)
    if [[ "${MOCK_VALIDATE_BODY:-}" == "1" ]]; then
        assert_no_body_errors
    fi

    # State tracking (when enabled)
    if [[ "${MOCK_TRACK_STATE:-}" == "1" ]]; then
        assert_server_cleaned_up "${state_file}"
    fi

    # Write per-test result to RESULTS_FILE (used by qa-dry-run.sh / qa-cycle.sh)
    if [[ -n "${RESULTS_FILE:-}" ]]; then
        local pre_fail=$((FAILED - _pre_failed))
        if [[ "$pre_fail" -gt 0 ]]; then
            printf '%s/%s:fail\n' "${cloud}" "${agent}" >> "${RESULTS_FILE}"
        else
            printf '%s/%s:pass\n' "${cloud}" "${agent}" >> "${RESULTS_FILE}"
        fi
    fi

    printf '\n'
}

# ============================================================
# Main
# ============================================================

printf '%b\n' "${CYAN}===============================${NC}"
printf '%b\n' "${CYAN} Spawn Mock Test Suite${NC}"
printf '%b\n' "${CYAN}===============================${NC}"
printf '\n'

# Parse arguments
FILTER_CLOUD="${1:-}"
FILTER_AGENT="${2:-}"

# Set up mocks once
setup_mock_curl
setup_mock_ssh
setup_mock_agents

# Discover what to test
if [[ -n "$FILTER_CLOUD" ]]; then
    CLOUDS="$FILTER_CLOUD"
    if [[ ! -d "${FIXTURES_DIR}/${FILTER_CLOUD}" ]]; then
        printf '%b\n' "${RED}No fixtures for cloud: ${FILTER_CLOUD}${NC}"
        printf "Available: %s\n" "$(discover_clouds | tr '\n' ' ')"
        exit 1
    fi
else
    CLOUDS=$(discover_clouds)
fi

if [[ -z "$CLOUDS" ]]; then
    printf '%b\n' "${YELLOW}No fixture data found in ${FIXTURES_DIR}/${NC}"
    printf "Run test/record.sh first to record API fixtures.\n"
    exit 0
fi

printf "Fixtures dir: %s\n" "${FIXTURES_DIR}"
printf "Clouds:       %s\n" "$CLOUDS"
printf '\n'

for cloud in $CLOUDS; do
    printf '%b\n' "${CYAN}━━━ ${cloud} ━━━${NC}"

    if [[ -n "$FILTER_AGENT" ]]; then
        AGENTS="$FILTER_AGENT"
    else
        AGENTS=$(discover_agents "$cloud")
    fi

    if [[ -z "$AGENTS" ]]; then
        printf '%b\n' "  ${YELLOW}skip${NC} no agent scripts found in ${cloud}/"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    for agent in $AGENTS; do
        run_test "$cloud" "$agent"
    done
    printf '\n'
done

# --- Summary ---
printf '%b\n' "${CYAN}===============================${NC}"
TOTAL=$((PASSED + FAILED + SKIPPED))
printf '%b\n' " Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}, ${TOTAL} total"
printf '%b\n' "${CYAN}===============================${NC}"

if [[ "$FAILED" -gt 0 ]]; then
    exit 1
fi
exit 0
