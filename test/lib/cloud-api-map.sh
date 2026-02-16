#!/bin/bash
# Shared cloud API base-URL stripping and POST-body field requirements.
# Sourced by both test/mock-curl-script.sh (runtime) and test/mock.sh (harness)
# so that adding a new cloud only requires updating ONE file.

# Strip the cloud-specific API base from a URL and return just the endpoint path.
# Usage (positional):  strip_cloud_api_base "$url"   -> prints clean endpoint
# Usage (global):      Sets ENDPOINT and EP_CLEAN globals when called as
#                      _strip_api_base (mock-curl-script.sh compat).
strip_cloud_api_base() {
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

# Return the required POST body fields for a cloud+endpoint combo.
# Usage: get_required_post_fields CLOUD ENDPOINT
# Prints space-separated field names, or empty if none required.
get_required_post_fields() {
    local cloud="$1"
    local endpoint="$2"

    case "${cloud}:${endpoint}" in
        hetzner:/servers)       echo "name server_type image location" ;;
        digitalocean:/droplets) echo "name region size image" ;;
        ovh:*/create)           echo "name" ;;
    esac
}
