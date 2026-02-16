#!/bin/bash
# Shared test helpers for mock infrastructure
# Used by both test/mock.sh and test/mock-curl-script.sh
#
# These functions are extracted to avoid duplication and ensure
# consistent behavior across the test suite.

# Strip API base URL to get just the endpoint path.
# Used by test infrastructure to validate cloud coverage.
# Args: url
# Output: endpoint path (e.g., "/servers" from "https://api.hetzner.cloud/v1/servers")
_strip_api_base() {
    local url="$1"
    local endpoint="$url"

    case "$url" in
        https://api.hetzner.cloud/v1*)
            endpoint="${url#https://api.hetzner.cloud/v1}" ;;
        https://api.digitalocean.com/v2*)
            endpoint="${url#https://api.digitalocean.com/v2}" ;;
        *eu.api.ovh.com*)
            endpoint=$(echo "$url" | sed 's|https://eu.api.ovh.com/1.0||') ;;
    esac

    echo "$endpoint" | sed 's|?.*||'
}

# Get required POST body fields for a cloud endpoint.
# Args: cloud endpoint
# Output: space-separated list of required field names
_get_required_fields() {
    local cloud="$1"
    local endpoint="$2"

    case "${cloud}:${endpoint}" in
        hetzner:/servers) echo "name server_type image location" ;;
        digitalocean:/droplets) echo "name region size image" ;;
        ovh:*/create) echo "name" ;;
    esac
}

# Check if required fields are present in POST body JSON.
# Logs BODY_ERROR to MOCK_LOG if fields are missing.
# Args: fields body url_or_endpoint
_check_fields() {
    local fields="$1"
    local body="$2"
    local url_or_endpoint="$3"

    for field in $fields; do
        if ! printf '%s' "$body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert '$field' in d" 2>/dev/null; then
            echo "BODY_ERROR:missing_field:${field}:${url_or_endpoint}" >> "${MOCK_LOG}"
        fi
    done
}

# Validate POST request body contains required fields for major clouds.
# Used during mock script execution to catch invalid API requests.
# Args: cloud method endpoint body
# Returns: 0 on success, 1 if JSON is invalid
_validate_body() {
    local cloud="$1"
    local method="$2"
    local endpoint="$3"
    local body="$4"

    [[ "$method" != "POST" ]] && return 0
    [[ -z "$body" ]] && return 0

    local required_fields
    required_fields=$(_get_required_fields "$cloud" "$endpoint")
    [[ -z "$required_fields" ]] && return 0

    # Check if body is valid JSON
    if ! printf '%s' "$body" | python3 -c "import json,sys; json.loads(sys.stdin.read())" 2>/dev/null; then
        echo "BODY_ERROR:invalid_json:${endpoint}" >> "${MOCK_LOG}"
        return 1
    fi

    # Check for required fields
    _check_fields "$required_fields" "$body" "$endpoint"

    return 0
}
