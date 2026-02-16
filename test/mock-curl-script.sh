#!/bin/bash
# Mock curl — returns fixture data based on URL
# Env vars from parent: MOCK_LOG, MOCK_FIXTURE_DIR, MOCK_CLOUD

# --- Helper functions ---

_parse_args() {
    METHOD="GET"
    URL=""
    BODY=""
    HAS_WRITE_OUT=false
    local prev_flag=""

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
}

_maybe_inject_error() {
    [ -n "${MOCK_ERROR_SCENARIO:-}" ] || return 1
    case "$URL" in
        *openrouter.ai*|*raw.githubusercontent.com*|*claude.ai/install*|*bun.sh*|*goose*|*nodesource*|*plandex.ai*|*opencode*|*pip.pypa.io*|*get.docker.com*|*npmjs.org*|*github.com/*/releases*)
            return 1 ;;
    esac
    case "${MOCK_ERROR_SCENARIO}" in
        auth_failure)
            printf '{"error":"Unauthorized"}'
            if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n401'; fi
            exit 1 ;;
        rate_limit)
            printf '{"error":"Rate limit exceeded"}'
            if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n429'; fi
            exit 1 ;;
        server_error)
            printf '{"error":"Internal server error"}'
            if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n500'; fi
            exit 1 ;;
        create_failure)
            if [ "$METHOD" = "POST" ]; then
                case "$URL" in
                    *servers*|*droplets*|*instances*)
                        printf '{"error":"Unprocessable entity"}'
                        if [ "$HAS_WRITE_OUT" = "true" ]; then printf '\n422'; fi
                        exit 1 ;;
                esac
            fi ;;
    esac
    return 1
}

_handle_special_urls() {
    case "$URL" in
        *claude.ai/install*|*bun.sh*|*goose*download_cli*|*nodesource*|*plandex.ai*|*opencode*install*|\
        *pip.pypa.io*|*get.docker.com*|*raw.githubusercontent.com/block/goose*|*install.python-poetry.org*|\
        *npmjs.org*|*deb.nodesource.com*|*github.com/*/releases*|*cli.github.com*)
            printf '#!/bin/bash\nexit 0\n'
            exit 0 ;;
        *raw.githubusercontent.com/OpenRouterTeam/spawn/*)
            local_path="${MOCK_REPO_ROOT}/${URL##*spawn/main/}"
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
        https://api.hetzner.cloud/v1*)     ENDPOINT="${URL#https://api.hetzner.cloud/v1}" ;;
        https://api.digitalocean.com/v2*)   ENDPOINT="${URL#https://api.digitalocean.com/v2}" ;;
        *eu.api.ovh.com*)                   ENDPOINT=$(echo "$URL" | sed 's|https://eu.api.ovh.com/1.0||') ;;
        https://api.machines.dev/v1*)       ENDPOINT="${URL#https://api.machines.dev/v1}" ;;
        https://www.googleapis.com*)        ENDPOINT=$(echo "$URL" | sed 's|https://www.googleapis.com||') ;;
        https://lightsail.amazonaws.com*)   ENDPOINT="${URL#https://lightsail.amazonaws.com}" ;;
        https://api.daytona.io*)            ENDPOINT="${URL#https://api.daytona.io}" ;;
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

_validate_body() {
    [ "${MOCK_VALIDATE_BODY:-}" = "1" ] && [ -n "$BODY" ] && [ "$METHOD" = "POST" ] || return 0
    if ! printf '%s' "$BODY" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${URL}" >> "${MOCK_LOG}"
        return 0
    fi
    case "${MOCK_CLOUD}" in
        hetzner)     case "$EP_CLEAN" in /servers)          _check_fields "name server_type image location" ;; esac ;;
        digitalocean) case "$EP_CLEAN" in /droplets)        _check_fields "name region size image" ;; esac ;;
        ovh)         case "$EP_CLEAN" in */create)          _check_fields "name" ;; esac ;;
    esac
}

_try_fixture() {
    local f="${MOCK_FIXTURE_DIR}/$1.json"
    if [ -f "$f" ]; then cat "$f"; return 0; fi
    return 1
}

_synthetic_active_response() {
    case "$MOCK_CLOUD" in
        digitalocean) printf '{"droplet":{"id":12345678,"name":"test-srv","status":"active","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}' ;;
        hetzner)      printf '{"server":{"id":99999,"name":"test-srv","status":"running","public_net":{"ipv4":{"ip":"10.0.0.1"}}}}' ;;
        *)            printf '{}' ;;
    esac
}

_respond_get() {
    local FIXTURE_NAME
    FIXTURE_NAME=$(echo "$EP_CLEAN" | sed 's|^/||; s|/|_|g')

    local LAST_SEG HAS_ID_SUFFIX=false
    LAST_SEG=$(echo "$EP_CLEAN" | sed 's|.*/||')
    case "$LAST_SEG" in *[0-9]*) HAS_ID_SUFFIX=true ;; esac

    if _try_fixture "$FIXTURE_NAME"; then
        :
    elif [ "$HAS_ID_SUFFIX" = "false" ]; then
        local FIXTURE_NAME_BASE
        FIXTURE_NAME_BASE=$(echo "$FIXTURE_NAME" | sed 's|_[0-9a-f-]*$||')
        if ! _try_fixture "$FIXTURE_NAME_BASE"; then
            echo "NO_FIXTURE:GET:${EP_CLEAN}:${FIXTURE_NAME}" >> "${MOCK_LOG}"
            printf '{}'
        fi
    else
        # ID-suffixed GET (e.g., /servers/12345) — use synthetic for status polling
        _synthetic_active_response
    fi
}

_respond_post() {
    case "$EP_CLEAN" in
        /ssh_keys|/ssh-keys|/account/keys|/profile/sshkeys|/sshkeys|*/sshkey)
            printf '{"ssh_key":{"id":99999,"name":"test-key","fingerprint":"af:0d:c5:57:a8:fd:b2:82:5e:d4:c1:65:f0:0c:8a:9d"}}'
            ;;
        *)
            if _try_fixture "create_server"; then
                :
            else
                echo "NO_FIXTURE:POST:${EP_CLEAN}:create_server" >> "${MOCK_LOG}"
                case "$MOCK_CLOUD" in
                    hetzner)      printf '{"server":{"id":99999,"name":"test-srv","public_net":{"ipv4":{"ip":"10.0.0.1"}}},"action":{"id":1,"status":"running"}}' ;;
                    digitalocean) printf '{"droplet":{"id":12345678,"name":"test-srv","status":"new","networks":{"v4":[{"ip_address":"10.0.0.1","type":"public"}]}}}' ;;
                    *)            printf '{"id":"test-id","status":"active","ip":"10.0.0.1"}' ;;
                esac
            fi
            ;;
    esac
}

_track_state() {
    [ "${MOCK_TRACK_STATE:-}" = "1" ] && [ -n "${MOCK_STATE_FILE:-}" ] || return 0
    local TS
    TS=$(date +%s)
    case "$METHOD" in
        POST)
            case "$EP_CLEAN" in
                /servers|/droplets|/instances|/instance-operations/launch)
                    echo "CREATED:${MOCK_CLOUD}:${TS}" >> "${MOCK_STATE_FILE}" ;;
            esac ;;
        DELETE)
            echo "DELETED:${MOCK_CLOUD}:${TS}" >> "${MOCK_STATE_FILE}" ;;
    esac
}

# --- Main logic ---

_parse_args "$@"

echo "curl ${METHOD} ${URL}" >> "${MOCK_LOG}"
if [ -n "$BODY" ]; then
    echo "BODY:${BODY}" >> "${MOCK_LOG}"
fi

_maybe_inject_error
_handle_special_urls

if [ -z "$URL" ]; then exit 0; fi

_strip_api_base
_validate_body

case "$METHOD" in
    GET)    _respond_get ;;
    POST)   _respond_post ;;
    DELETE) _try_fixture "delete_server" || printf '{}' ;;
    *)      printf '{}' ;;
esac

_track_state

if [ "$HAS_WRITE_OUT" = "true" ]; then
    printf '\n200'
fi

exit 0
