#!/bin/bash
# Mock curl — returns fixture data based on URL
# Env vars from parent: MOCK_LOG, MOCK_FIXTURE_DIR, MOCK_CLOUD
#
# This script is installed as 'curl' on $PATH during mock tests.
# Extracted from the setup_mock_curl() heredoc in mock.sh for readability.

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

# --- Error injection (opt-in via MOCK_ERROR_SCENARIO) ---
if [ -n "${MOCK_ERROR_SCENARIO:-}" ]; then
    case "$URL" in
        *openrouter.ai*|*raw.githubusercontent.com*|*claude.ai/install*|*bun.sh*|*goose*|*nodesource*|*plandex.ai*|*opencode*|*pip.pypa.io*|*get.docker.com*|*npmjs.org*|*github.com/*/releases*)
            # Don't inject errors for install/download URLs or OpenRouter
            ;;
        *)
            case "${MOCK_ERROR_SCENARIO}" in
                auth_failure)
                    printf '{"error":"Unauthorized"}'
                    if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n401'; fi
                    exit 1
                    ;;
                rate_limit)
                    printf '{"error":"Rate limit exceeded"}'
                    if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n429'; fi
                    exit 1
                    ;;
                server_error)
                    printf '{"error":"Internal server error"}'
                    if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n500'; fi
                    exit 1
                    ;;
                create_failure)
                    if [ "$METHOD" = "POST" ]; then
                        case "$URL" in
                            *servers*|*droplets*|*instances*)
                                printf '{"error":"Unprocessable entity"}'
                                if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n422'; fi
                                exit 1
                                ;;
                        esac
                    fi
                    ;;
            esac
            ;;
    esac
fi

# --- Install script downloads -> return no-op ---
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
    https://cloud.lambdalabs.com/api/v1*)  ENDPOINT="${URL#https://cloud.lambdalabs.com/api/v1}" ;;
    https://api.civo.com/v2*)           ENDPOINT="${URL#https://api.civo.com/v2}" ;;
    https://api.upcloud.com/1.3*)       ENDPOINT="${URL#https://api.upcloud.com/1.3}" ;;
    https://api.binarylane.com.au/v2*)  ENDPOINT="${URL#https://api.binarylane.com.au/v2}" ;;
    https://api.scaleway.com/*)         ENDPOINT=$(echo "$URL" | sed 's|https://api.scaleway.com/instance/v1/zones/[^/]*/||') ;;
    https://api.genesiscloud.com/compute/v1*) ENDPOINT="${URL#https://api.genesiscloud.com/compute/v1}" ;;
    https://console.kamatera.com/svc*)  ENDPOINT="${URL#https://console.kamatera.com/svc}" ;;
    https://api.latitude.sh*)           ENDPOINT="${URL#https://api.latitude.sh}" ;;
    https://infrahub-api.nexgencloud.com/v1*) ENDPOINT="${URL#https://infrahub-api.nexgencloud.com/v1}" ;;
    *eu.api.ovh.com*)                   ENDPOINT=$(echo "$URL" | sed 's|https://eu.api.ovh.com/1.0||') ;;
esac

# Strip query params for matching
EP_CLEAN=$(echo "$ENDPOINT" | sed 's|?.*||')

# --- Body validation (opt-in via MOCK_VALIDATE_BODY=1) ---
if [ "${MOCK_VALIDATE_BODY:-}" = "1" ] && [ -n "$BODY" ] && [ "$METHOD" = "POST" ]; then
    # Check body is valid JSON
    if ! printf '%s' "$BODY" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${URL}" >> "${MOCK_LOG}"
    else
        # Check required fields per cloud+endpoint
        _check_fields() {
            local fields="$1"
            for field in $fields; do
                if ! printf '%s' "$BODY" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert '$field' in d" 2>/dev/null; then
                    echo "BODY_ERROR:missing_field:${field}:${URL}" >> "${MOCK_LOG}"
                fi
            done
        }
        case "${MOCK_CLOUD}" in
            hetzner)
                case "$EP_CLEAN" in /servers) _check_fields "name server_type image location" ;; esac
                ;;
            digitalocean)
                case "$EP_CLEAN" in /droplets) _check_fields "name region size image" ;; esac
                ;;
            vultr)
                case "$EP_CLEAN" in /instances) _check_fields "label region plan os_id" ;; esac
                ;;
            linode)
                case "$EP_CLEAN" in /linode/instances) _check_fields "label region type image" ;; esac
                ;;
            civo)
                case "$EP_CLEAN" in /instances) _check_fields "hostname size region" ;; esac
                ;;
        esac
    fi
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
        # e.g. /droplets/12345678, /instances/test-uuid-1234 -> ID
        # e.g. /droplets, /instances, /account/keys -> collection
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
                lambda)
                    printf '{"data":{"id":"test-uuid-1234","name":"test-srv","status":"active","ip":"10.0.0.1"}}'
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

# --- State tracking (opt-in via MOCK_TRACK_STATE=1) ---
if [ "${MOCK_TRACK_STATE:-}" = "1" ] && [ -n "${MOCK_STATE_FILE:-}" ]; then
    TS=$(date +%s)
    case "$METHOD" in
        POST)
            case "$EP_CLEAN" in
                /servers|/droplets|/instances|/linode/instances|/instance-operations/launch)
                    echo "CREATED:${MOCK_CLOUD}:${TS}" >> "${MOCK_STATE_FILE}"
                    ;;
            esac
            ;;
        DELETE)
            echo "DELETED:${MOCK_CLOUD}:${TS}" >> "${MOCK_STATE_FILE}"
            ;;
    esac
fi

# Append HTTP status code if -w was used
if [ "$HAS_WRITE_OUT" = "true" ]; then
    printf '\n200'
fi

exit 0
