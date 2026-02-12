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
    local first_word
    first_word=$(printf '%s' "$var_name" | sed 's/_.*//' | tr '[:upper:]' '[:lower:]')
    if grep -qiE "${first_word}" "${MOCK_LOG}" "${TEST_DIR}/output.log" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_no_body_errors() {
    local msg="${1:-no request body errors}"
    if grep -qE "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null; then
        local errors
        errors=$(grep -c "BODY_ERROR:" "${MOCK_LOG}" 2>/dev/null || true)
        printf '%b\n' "    ${RED}✗${NC} ${msg} (${errors} body error(s))"
        FAILED=$((FAILED + 1))
    else
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    fi
}

assert_server_cleaned_up() {
    local msg="${1:-server lifecycle tracked}"
    if [[ -n "${MOCK_STATE_FILE:-}" ]] && [[ -f "${MOCK_STATE_FILE}" ]]; then
        local created deleted
        created=$(grep -c "^CREATED:" "${MOCK_STATE_FILE}" 2>/dev/null || true)
        deleted=$(grep -c "^DELETED:" "${MOCK_STATE_FILE}" 2>/dev/null || true)
        if [[ "$created" -gt 0 ]]; then
            printf '%b\n' "    ${GREEN}✓${NC} ${msg} (${created} created, ${deleted} deleted)"
            PASSED=$((PASSED + 1))
        else
            printf '%b\n' "    ${YELLOW}⚠${NC} ${msg} (no server creation tracked)"
            PASSED=$((PASSED + 1))
        fi
    else
        printf '%b\n' "    ${GREEN}✓${NC} ${msg} (state tracking not enabled)"
        PASSED=$((PASSED + 1))
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

# Parse curl arguments
METHOD="GET"
URL=""
BODY=""
HAS_WRITE_OUT=false
prev_flag=""

for arg in "$@"; do
    case "$prev_flag" in
        -X) METHOD="$arg"; prev_flag=""; continue ;;
        -w)
            case "$arg" in
                *http_code*) HAS_WRITE_OUT=true ;;
            esac
            prev_flag=""; continue
            ;;
        -d) BODY="$arg"; prev_flag=""; continue ;;
        -H|-o|-u|--connect-timeout|--max-time|--retry|--retry-delay) prev_flag=""; continue ;;
    esac
    case "$arg" in
        -X|-w|-d|-H|-o|-u|--connect-timeout|--max-time|--retry|--retry-delay) prev_flag="$arg"; continue ;;
        -s|-f|-S|-L|-k|-#|-fsSL|-fsS|-sS) continue ;;
        http://*|https://*) URL="$arg" ;;
    esac
done

echo "curl ${METHOD} ${URL}" >> "${MOCK_LOG}"
if [ -n "$BODY" ]; then
    echo "BODY:${BODY}" >> "${MOCK_LOG}"
fi

# --- Install script downloads → return no-op ---
case "$URL" in
    *claude.ai/install*|*bun.sh*|*goose*download_cli*|*nodesource*|*plandex.ai*|*opencode*install*|\
    *pip.pypa.io*|*get.docker.com*|*raw.githubusercontent.com/block/goose*|*install.python-poetry.org*|\
    *npmjs.org*|*deb.nodesource.com*|*github.com/*/releases*|*cli.github.com*)
        printf '#!/bin/bash\nexit 0\n'
        exit 0
        ;;
    *raw.githubusercontent.com/OpenRouterTeam/spawn/*)
        # Remote source fallback — serve local file instead
        local_path="${MOCK_REPO_ROOT}/${URL##*spawn/main/}"
        if [ -f "$local_path" ]; then
            cat "$local_path"
        fi
        exit 0
        ;;
    *openrouter.ai*)
        # OAuth check / API key exchange — return success
        printf '{"key":"sk-or-v1-mock"}\n'
        if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n200'; fi
        exit 0
        ;;
esac

# --- Error injection (when MOCK_ERROR_SCENARIO is set) ---
if [ -n "${MOCK_ERROR_SCENARIO:-}" ] && [ -n "$URL" ]; then
    case "$URL" in *openrouter.ai*|*raw.githubusercontent.com*|*bun.sh*|*claude.ai*) ;; *)
        case "${MOCK_ERROR_SCENARIO}" in
            auth_failure)
                printf '{"error":"Unauthorized"}'
                if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n401'; fi
                exit 0
                ;;
            rate_limit)
                printf '{"error":"Rate limit exceeded"}'
                if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n429'; fi
                exit 0
                ;;
            server_error)
                printf '{"error":"Internal server error"}'
                if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n500'; fi
                exit 0
                ;;
            create_failure)
                if [ "$METHOD" = "POST" ]; then
                    printf '{"error":"Unprocessable entity"}'
                    if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n422'; fi
                    exit 0
                fi
                ;;
        esac
    ;; esac
fi

# --- API calls: route by cloud + endpoint ---
if [ -z "$URL" ]; then
    exit 0
fi

# Strip API base to get endpoint
ENDPOINT="$URL"
case "$URL" in
    https://api.hetzner.cloud/v1*)     ENDPOINT="${URL#https://api.hetzner.cloud/v1}" ;;
    https://api.digitalocean.com/v2*)   ENDPOINT="${URL#https://api.digitalocean.com/v2}" ;;
    https://api.vultr.com/v2*)          ENDPOINT="${URL#https://api.vultr.com/v2}" ;;
    https://api.linode.com/v4*)         ENDPOINT="${URL#https://api.linode.com/v4}" ;;
    https://api.lambdalabs.com/v1*)     ENDPOINT="${URL#https://api.lambdalabs.com/v1}" ;;
    https://api.civo.com/v2*)           ENDPOINT="${URL#https://api.civo.com/v2}" ;;
    https://api.upcloud.com/1.3*)       ENDPOINT="${URL#https://api.upcloud.com/1.3}" ;;
    https://api.binarylane.com.au/v2*)  ENDPOINT="${URL#https://api.binarylane.com.au/v2}" ;;
    https://api.scaleway.com/*)         ENDPOINT=$(echo "$URL" | sed 's|https://api.scaleway.com/instance/v1/zones/[^/]*/||') ;;
    https://api.genesiscloud.com/compute/v1*) ENDPOINT="${URL#https://api.genesiscloud.com/compute/v1}" ;;
    https://console.kamatera.com/svc*)  ENDPOINT="${URL#https://console.kamatera.com/svc}" ;;
    https://api.latitude.sh*)           ENDPOINT="${URL#https://api.latitude.sh}" ;;
    https://infrahub-api.nexgencloud.com/v1*) ENDPOINT="${URL#https://infrahub-api.nexgencloud.com/v1}" ;;
    *eu.api.ovh.com*)                   ENDPOINT=$(echo "$URL" | sed 's|https://eu.api.ovh.com/1.0||') ;;
    https://openstack.ramnode.com:5000/v3*)   ENDPOINT="${URL#https://openstack.ramnode.com:5000/v3}" ;;
    https://openstack.ramnode.com:8774/v2.1*) ENDPOINT="${URL#https://openstack.ramnode.com:8774/v2.1}" ;;
    https://openstack.ramnode.com:9696/v2.0*) ENDPOINT="${URL#https://openstack.ramnode.com:9696/v2.0}" ;;
esac

# Strip query params for matching
EP_CLEAN=$(echo "$ENDPOINT" | sed 's|?.*||')

# Body validation (opt-in via MOCK_VALIDATE_BODY=1)
if [ "${MOCK_VALIDATE_BODY:-}" = "1" ] && [ "$METHOD" = "POST" ] && [ -n "$BODY" ]; then
    # Check valid JSON
    if ! printf '%s' "$BODY" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${URL}" >> "${MOCK_LOG}"
    else
        # Check required fields per cloud+endpoint
        _check_field() {
            if ! printf '%s' "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);assert '$1' in d" 2>/dev/null; then
                echo "BODY_ERROR:missing_field:$1:${URL}" >> "${MOCK_LOG}"
            fi
        }
        case "${MOCK_CLOUD}" in
            hetzner)
                case "$EP_CLEAN" in */servers)
                    _check_field "name"; _check_field "server_type"; _check_field "image"; _check_field "location" ;; esac ;;
            digitalocean)
                case "$EP_CLEAN" in */droplets)
                    _check_field "name"; _check_field "region"; _check_field "size"; _check_field "image" ;; esac ;;
            vultr)
                case "$EP_CLEAN" in */instances)
                    _check_field "label"; _check_field "region"; _check_field "plan"; _check_field "os_id" ;; esac ;;
            linode)
                case "$EP_CLEAN" in */linode/instances)
                    _check_field "label"; _check_field "region"; _check_field "type"; _check_field "image" ;; esac ;;
            civo)
                case "$EP_CLEAN" in */instances)
                    _check_field "hostname"; _check_field "size"; _check_field "region" ;; esac ;;
        esac
    fi
fi

# State tracking (opt-in via MOCK_TRACK_STATE=1)
if [ "${MOCK_TRACK_STATE:-}" = "1" ] && [ -n "${MOCK_STATE_FILE:-}" ]; then
    case "$METHOD" in
        POST)
            case "$EP_CLEAN" in
                */servers|*/droplets|*/instances|*/linode/instances)
                    echo "CREATED:${MOCK_CLOUD}:$(date +%s)" >> "${MOCK_STATE_FILE}" ;;
            esac ;;
        DELETE)
            echo "DELETED:${MOCK_CLOUD}:$(date +%s)" >> "${MOCK_STATE_FILE}" ;;
    esac
fi

# Try to find fixture file
_try_fixture() {
    local f="${MOCK_FIXTURE_DIR}/$1.json"
    if [ -f "$f" ]; then
        cat "$f"
        return 0
    fi
    return 1
}

# Route based on METHOD + endpoint
case "$METHOD" in
    GET)
        # Normalize endpoint to fixture name: strip leading /, replace / with _
        FIXTURE_NAME=$(echo "$EP_CLEAN" | sed 's|^/||; s|/|_|g')

        # Check if the last path segment is an ID (contains digits)
        # e.g. /droplets/12345678, /instances/test-uuid-1234 → ID
        # e.g. /droplets, /instances, /account/keys → collection
        HAS_ID_SUFFIX=false
        LAST_SEG=$(echo "$EP_CLEAN" | sed 's|.*/||')
        case "$LAST_SEG" in
            *[0-9]*) HAS_ID_SUFFIX=true ;;
        esac

        # Try exact fixture match first
        if _try_fixture "$FIXTURE_NAME"; then
            :
        elif [ "$HAS_ID_SUFFIX" = "false" ]; then
            # Only fall back to base fixture for list endpoints (no ID),
            # not for single-resource lookups like /droplets/12345678
            FIXTURE_NAME_BASE=$(echo "$FIXTURE_NAME" | sed 's|_[0-9a-f-]*$||')
            _try_fixture "$FIXTURE_NAME_BASE" || printf '{}'
        else
            # Single-resource lookup — return synthetic "active" response
            case "$MOCK_CLOUD" in
                digitalocean)
                    printf '{"droplet":{"id":12345678,"name":"test-srv","status":"active","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}'
                    ;;
                vultr)
                    printf '{"instance":{"id":"test-uuid-1234","main_ip":"10.0.0.1","status":"active","power_status":"running","label":"test-srv"}}'
                    ;;
                linode)
                    printf '{"id":12345678,"label":"test-srv","status":"running","ipv4":["10.0.0.1"]}'
                    ;;
                hetzner)
                    printf '{"server":{"id":99999,"name":"test-srv","status":"running","public_net":{"ipv4":{"ip":"10.0.0.1"}}}}'
                    ;;
                *) printf '{}' ;;
            esac
        fi
        ;;
    POST)
        case "$EP_CLEAN" in
            /ssh_keys|/ssh-keys|/account/keys|/profile/sshkeys|/sshkeys|*/sshkey)
                # SSH key registration — return success
                printf '{"ssh_key":{"id":99999,"name":"test-key","fingerprint":"af:0d:c5:57:a8:fd:b2:82:5e:d4:c1:65:f0:0c:8a:9d"}}'
                ;;
            *)
                # Server/instance creation
                if _try_fixture "create_server"; then
                    :
                else
                    case "$MOCK_CLOUD" in
                        hetzner)
                            printf '{"server":{"id":99999,"name":"test-srv","public_net":{"ipv4":{"ip":"10.0.0.1"}}},"action":{"id":1,"status":"running"}}'
                            ;;
                        digitalocean)
                            printf '{"droplet":{"id":12345678,"name":"test-srv","status":"new","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}'
                            ;;
                        vultr)
                            printf '{"instance":{"id":"test-uuid-1234","main_ip":"10.0.0.1","status":"active","power_status":"running","label":"test-srv"}}'
                            ;;
                        linode)
                            printf '{"id":12345678,"label":"test-srv","status":"running","ipv4":["10.0.0.1"]}'
                            ;;
                        *)
                            printf '{"id":"test-id","status":"active","ip":"10.0.0.1"}'
                            ;;
                    esac
                fi
                ;;
        esac
        ;;
    DELETE)
        if _try_fixture "delete_server"; then
            :
        else
            printf '{}'
        fi
        ;;
    *)
        printf '{}'
        ;;
esac

# Append HTTP status code if -w was used
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
    export MODEL_ID="openrouter/auto"
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
        local)
            # No cloud credentials needed for local
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
    local _prev_failed="$FAILED"

    if [[ ! -f "$script_path" ]]; then
        printf '%b\n' "  ${YELLOW}skip${NC} ${cloud}/${agent}.sh — file not found"
        SKIPPED=$((SKIPPED + 1))
        return 0
    fi

    printf '%b\n' "  ${CYAN}test${NC} ${cloud}/${agent}.sh"

    # Reset mock log
    : > "${MOCK_LOG}"

    # Set up environment
    setup_env_for_cloud "$cloud"

    # Fake HOME to avoid polluting real home
    local fake_home
    fake_home=$(setup_fake_home)

    # Run the script with mocked PATH + HOME (10s timeout — all calls are fake)
    local exit_code=0

    # Per-test state file for state tracking
    local state_file="${TEST_DIR}/state_${cloud}_${agent}.log"
    : > "${state_file}"

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
            printf '%b\n' "    ${GREEN}✓${NC} exits with error (expected for ${MOCK_ERROR_SCENARIO})"
            PASSED=$((PASSED + 1))
        else
            printf '%b\n' "    ${RED}✗${NC} should fail for ${MOCK_ERROR_SCENARIO} but exited 0"
            FAILED=$((FAILED + 1))
        fi
    else
        assert_exit_code "${exit_code}" 0 "exits successfully"
    fi

    # Cloud-specific API assertions
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
        *)
            assert_log_contains "curl (GET|POST) https://" "makes API calls"
            ;;
    esac

    # Check that SSH was used (for remote execution) — skip for local cloud
    if [[ "$cloud" != "local" ]]; then
        assert_log_contains "ssh " "uses SSH"
    fi

    # Check OpenRouter key injection
    assert_env_injected "OPENROUTER_API_KEY" "injects OPENROUTER_API_KEY"

    # Body validation assertions
    if [[ "${MOCK_VALIDATE_BODY:-}" == "1" ]]; then
        assert_no_body_errors
    fi

    # State tracking assertions
    if [[ "${MOCK_TRACK_STATE:-}" == "1" ]]; then
        MOCK_STATE_FILE="${state_file}" assert_server_cleaned_up
    fi

    # Append result to RESULTS_FILE if set
    if [[ -n "${RESULTS_FILE:-}" ]]; then
        if [[ "$FAILED" -gt "$_prev_failed" ]] || [[ "$exit_code" -ne 0 ]]; then
            printf '%s/%s:fail\n' "$cloud" "$agent" >> "${RESULTS_FILE}"
        else
            printf '%s/%s:pass\n' "$cloud" "$agent" >> "${RESULTS_FILE}"
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
