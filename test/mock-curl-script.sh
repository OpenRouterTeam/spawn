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
        https://api.vultr.com/v2*)          ENDPOINT="${URL#https://api.vultr.com/v2}" ;;
        https://api.linode.com/v4*)         ENDPOINT="${URL#https://api.linode.com/v4}" ;;
        https://cloud.lambdalabs.com/api/v1*)  ENDPOINT="${URL#https://cloud.lambdalabs.com/api/v1}" ;;
        https://api.civo.com/v2*)           ENDPOINT="${URL#https://api.civo.com/v2}" ;;
        https://api.upcloud.com/1.3*)       ENDPOINT="${URL#https://api.upcloud.com/1.3}" ;;
        https://api.binarylane.com.au/v2*)  ENDPOINT="${URL#https://api.binarylane.com.au/v2}" ;;
        https://api.scaleway.com/instance/v1/zones/*) ENDPOINT=$(echo "$URL" | sed 's|https://api.scaleway.com/instance/v1/zones/[^/]*/||') ;;
        https://api.scaleway.com/account/v3*) ENDPOINT="${URL#https://api.scaleway.com/account/v3}" ;;
        https://api.scaleway.com/*)         ENDPOINT=$(echo "$URL" | sed 's|https://api.scaleway.com/[^/]*/[^/]*/||') ;;
        https://api.genesiscloud.com/compute/v1*) ENDPOINT="${URL#https://api.genesiscloud.com/compute/v1}" ;;
        https://console.kamatera.com/svc*)  ENDPOINT="${URL#https://console.kamatera.com/svc}" ;;
        https://api.latitude.sh*)           ENDPOINT="${URL#https://api.latitude.sh}" ;;
        https://infrahub-api.nexgencloud.com/v1*) ENDPOINT="${URL#https://infrahub-api.nexgencloud.com/v1}" ;;
        *eu.api.ovh.com*)                   ENDPOINT=$(echo "$URL" | sed 's|https://eu.api.ovh.com/1.0||') ;;
        https://cloudapi.atlantic.net/*)    ENDPOINT=$(echo "$URL" | sed 's|https://cloudapi.atlantic.net/\?||') ;;
        https://invapi.hostkey.com*)        ENDPOINT="${URL#https://invapi.hostkey.com}" ;;
        https://*.cloudsigma.com/api/2.0*)  ENDPOINT=$(echo "$URL" | sed 's|https://[^/]*.cloudsigma.com/api/2.0||') ;;
        https://api.webdock.io/v1*)         ENDPOINT="${URL#https://api.webdock.io/v1}" ;;
        https://api.serverspace.io/api/v1*) ENDPOINT="${URL#https://api.serverspace.io/api/v1}" ;;
        https://api.gcore.com/cloud/v*/instances/*/*/*) ENDPOINT=$(echo "$URL" | sed 's|.*/instances/[^/]*/[^/]*/|/instances/|') ;;
        https://api.gcore.com/cloud/v*/instances/*/*) ENDPOINT="/instances" ;;
        https://api.gcore.com/cloud/v*/*/*/*/*) ENDPOINT=$(echo "$URL" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*/[^/]*/|/\1/|') ;;
        https://api.gcore.com/cloud/v*/*/*/*) ENDPOINT=$(echo "$URL" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*/[^/]*$|/\1|') ;;
        https://api.gcore.com/cloud/v*/*/*) ENDPOINT=$(echo "$URL" | sed 's|.*/cloud/v[0-9]*/\([^/]*\)/[^/]*$|/\1|') ;;
        https://api.gcore.com/cloud/v*/*) ENDPOINT=$(echo "$URL" | sed 's|.*/cloud/v[0-9]*/||; s|^|/|') ;;
        https://api.gcore.com*)            ENDPOINT="${URL#https://api.gcore.com}" ;;
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
        vultr)       case "$EP_CLEAN" in /instances)        _check_fields "label region plan os_id" ;; esac ;;
        linode)      case "$EP_CLEAN" in /linode/instances) _check_fields "label region type image" ;; esac ;;
        civo)        case "$EP_CLEAN" in /instances)        _check_fields "hostname size region" ;; esac ;;
        binarylane)  case "$EP_CLEAN" in /servers)          _check_fields "name region plan os_id" ;; esac ;;
        upcloud)     case "$EP_CLEAN" in /server)           _check_fields "server" ;; esac ;;
        genesiscloud) case "$EP_CLEAN" in /instances)       _check_fields "name" ;; esac ;;
        hyperstack)  case "$EP_CLEAN" in /servers)          _check_fields "name" ;; esac ;;
        kamatera)    case "$EP_CLEAN" in /server/create)    _check_fields "datacenter" ;; esac ;;
        latitude)    case "$EP_CLEAN" in /servers)          _check_fields "hostname site_id os_type" ;; esac ;;
        ovh)         case "$EP_CLEAN" in */create)          _check_fields "name" ;; esac ;;
        scaleway)    case "$EP_CLEAN" in /servers)          _check_fields "name" ;; esac ;;
        webdock)     case "$EP_CLEAN" in /servers)          _check_fields "name slug locationId profileSlug imageSlug" ;; esac ;;
        serverspace) case "$EP_CLEAN" in /servers)          _check_fields "name location_id image_id cpu ram_mb" ;; esac ;;
        gcore)       case "$EP_CLEAN" in /instances) _check_fields "name flavor volumes interfaces" ;; esac ;;
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
        vultr)        printf '{"instance":{"id":"test-uuid-1234","main_ip":"10.0.0.1","status":"active","power_status":"running","label":"test-srv"}}' ;;
        linode)       printf '{"id":12345678,"label":"test-srv","status":"running","ipv4":["10.0.0.1"]}' ;;
        hetzner)      printf '{"server":{"id":99999,"name":"test-srv","status":"running","public_net":{"ipv4":{"ip":"10.0.0.1"}}}}' ;;
        lambda)       printf '{"data":{"id":"test-uuid-1234","name":"test-srv","status":"active","ip":"10.0.0.1"}}' ;;
        civo)         printf '{"id":"test-uuid-1234","hostname":"test-srv","status":"ACTIVE","public_ip":"10.0.0.1","size":"g4s.small"}' ;;
        scaleway)     printf '{"server":{"id":"test-uuid-1234","name":"test-srv","state":"running","public_ip":{"address":"10.0.0.1"},"public_ips":[{"address":"10.0.0.1"}]}}' ;;
        serverspace)  printf '{"id":"test-uuid-1234","name":"test-srv","status":"Active","nics":[{"ip_address":"10.0.0.1"}]}' ;;
        gcore)        printf '{"id":"instance-uuid-5678","name":"test-srv","vm_state":"active","status":"ACTIVE","addresses":{"public":[ {"addr":"10.0.0.1","type":"fixed"}]},"flavor":{"flavor_id":"g1-standard-1-2"}}' ;;
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
    local TS
    TS=$(date +%s)
    case "$METHOD" in
        POST)
            case "$EP_CLEAN" in
                /servers|/droplets|/instances|/linode/instances|/instance-operations/launch)
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
