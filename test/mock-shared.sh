#!/bin/bash
# Shared functions for mock test infrastructure
# Sourced by both test/mock.sh and test/mock-curl-script.sh

# Strip API base URL to get just the endpoint path
# Args: url
# Outputs: endpoint path without query params
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

# Get required POST body fields for a cloud endpoint
# Args: cloud endpoint
# Outputs: space-separated field names
_get_required_fields() {
    local cloud="$1"
    local endpoint="$2"

    case "${cloud}:${endpoint}" in
        hetzner:/servers) echo "name server_type image location" ;;
        digitalocean:/droplets) echo "name region size image" ;;
        ovh:*/create) echo "name" ;;
    esac
}

# Validate POST request body contains required fields
# Args: cloud method endpoint body
# Returns: 0 on success, 1 on validation error
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
    for field in $required_fields; do
        if ! printf '%s' "$body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); assert '$field' in d" 2>/dev/null; then
            echo "BODY_ERROR:missing_field:${field}:${endpoint}" >> "${MOCK_LOG}"
        fi
    done

    return 0
}
