#!/bin/bash
# e2e/lib/clouds/digitalocean.sh — DigitalOcean cloud driver for E2E tests
#
# Implements the standard cloud driver interface (_digitalocean_*) for
# provisioning and managing DigitalOcean droplets in the E2E test suite.
#
# Requires: DO_API_TOKEN, jq, ssh
# API: https://api.digitalocean.com/v2
# SSH user: root
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_DO_API="https://api.digitalocean.com/v2"
_DO_DEFAULT_SIZE="s-2vcpu-2gb"
_DO_DEFAULT_REGION="nyc3"

# ---------------------------------------------------------------------------
# _digitalocean_validate_env
#
# Validates that DO_API_TOKEN is set and the DigitalOcean API is reachable
# with valid credentials.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_digitalocean_validate_env() {
  if [ -z "${DO_API_TOKEN:-}" ]; then
    log_err "DO_API_TOKEN is not set"
    return 1
  fi

  if ! curl -sf \
    -H "Authorization: Bearer ${DO_API_TOKEN}" \
    "${_DO_API}/account" >/dev/null 2>&1; then
    log_err "DigitalOcean API authentication failed — check DO_API_TOKEN"
    return 1
  fi

  log_ok "DigitalOcean credentials validated"
  return 0
}

# ---------------------------------------------------------------------------
# _digitalocean_headless_env APP AGENT
#
# Prints export lines for headless provisioning environment variables.
# These are consumed by the spawn CLI when running in non-interactive mode.
# ---------------------------------------------------------------------------
_digitalocean_headless_env() {
  local app="$1"
  # local agent="$2"  # unused but part of the interface

  printf 'export DO_DROPLET_NAME="%s"\n' "${app}"
  printf 'export DO_DROPLET_SIZE="%s"\n' "${DO_DROPLET_SIZE:-${_DO_DEFAULT_SIZE}}"
  printf 'export DO_REGION="%s"\n' "${DO_REGION:-${_DO_DEFAULT_REGION}}"
}

# ---------------------------------------------------------------------------
# _digitalocean_provision_verify APP LOG_DIR
#
# Verifies that a droplet with the given name exists. Extracts its ID and
# public IPv4 address. Writes the IP to $LOG_DIR/$APP.ip and JSON metadata
# (id, name, region) to $LOG_DIR/$APP.meta.
# Returns 0 if found, 1 if not.
# ---------------------------------------------------------------------------
_digitalocean_provision_verify() {
  local app="$1"
  local log_dir="$2"

  log_step "Checking for droplet ${app}..."

  local droplets_json
  droplets_json=$(curl -sf \
    -H "Authorization: Bearer ${DO_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${_DO_API}/droplets?per_page=200" 2>/dev/null || true)

  if [ -z "${droplets_json}" ]; then
    log_err "Failed to list DigitalOcean droplets"
    return 1
  fi

  # Find the droplet matching the app name
  local droplet_json
  droplet_json=$(printf '%s' "${droplets_json}" | jq -r \
    --arg name "${app}" \
    '.droplets[] | select(.name == $name)' 2>/dev/null || true)

  if [ -z "${droplet_json}" ]; then
    log_err "Droplet ${app} not found"
    return 1
  fi

  # Extract droplet ID
  local droplet_id
  droplet_id=$(printf '%s' "${droplet_json}" | jq -r '.id' 2>/dev/null || true)

  if [ -z "${droplet_id}" ] || [ "${droplet_id}" = "null" ]; then
    log_err "Could not extract droplet ID for ${app}"
    return 1
  fi

  # Extract public IPv4 address
  local droplet_ip
  droplet_ip=$(printf '%s' "${droplet_json}" | jq -r \
    '.networks.v4[] | select(.type == "public") | .ip_address' 2>/dev/null | head -1 || true)

  if [ -z "${droplet_ip}" ] || [ "${droplet_ip}" = "null" ]; then
    log_err "Could not extract public IP for droplet ${app}"
    return 1
  fi

  # Extract region slug
  local droplet_region
  droplet_region=$(printf '%s' "${droplet_json}" | jq -r '.region.slug // "unknown"' 2>/dev/null || true)

  # Write IP file
  printf '%s' "${droplet_ip}" > "${log_dir}/${app}.ip"

  # Write metadata file
  printf '{"id":%s,"name":"%s","region":"%s"}\n' \
    "${droplet_id}" "${app}" "${droplet_region}" > "${log_dir}/${app}.meta"

  log_ok "Droplet ${app} found — ID: ${droplet_id}, IP: ${droplet_ip}, Region: ${droplet_region}"
  return 0
}

# ---------------------------------------------------------------------------
# _digitalocean_exec APP CMD
#
# Executes a command on the droplet via SSH as root.
# Reads the IP from $LOG_DIR/$APP.ip.
# ---------------------------------------------------------------------------
_digitalocean_exec() {
  local app="$1"
  local cmd="$2"

  local ip_file="${LOG_DIR:-/tmp}/${app}.ip"
  if [ ! -f "${ip_file}" ]; then
    log_err "IP file not found: ${ip_file}"
    return 1
  fi

  local ip
  ip=$(cat "${ip_file}")

  if [ -z "${ip}" ]; then
    log_err "Empty IP in ${ip_file}"
    return 1
  fi

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      "root@${ip}" "${cmd}"
}

# ---------------------------------------------------------------------------
# _digitalocean_exec_long APP CMD TIMEOUT
#
# Same as _digitalocean_exec but with ServerAliveInterval for long-running
# commands, and wraps the command in `timeout`.
# ---------------------------------------------------------------------------
_digitalocean_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout_secs="${3:-120}"

  local ip_file="${LOG_DIR:-/tmp}/${app}.ip"
  if [ ! -f "${ip_file}" ]; then
    log_err "IP file not found: ${ip_file}"
    return 1
  fi

  local ip
  ip=$(cat "${ip_file}")

  if [ -z "${ip}" ]; then
    log_err "Empty IP in ${ip_file}"
    return 1
  fi

  # Base64-encode the command to avoid shell injection via single-quote breakout
  local encoded_cmd
  encoded_cmd=$(printf '%s' "${cmd}" | base64 | tr -d '\n')

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      -o "ServerAliveInterval=15" -o "ServerAliveCountMax=$((timeout_secs / 15 + 1))" \
      "root@${ip}" "timeout ${timeout_secs} bash -c \"\$(printf '%s' '${encoded_cmd}' | base64 -d)\""
}

# ---------------------------------------------------------------------------
# _digitalocean_teardown APP
#
# Deletes the droplet by its ID (read from the .meta file) and untracks it.
# Retries the DELETE up to 3 times on failure, then polls the API to confirm
# the droplet is actually gone (up to 60s). This prevents batch 2 from
# launching while batch 1 droplets still occupy the account's droplet limit.
# ---------------------------------------------------------------------------
_digitalocean_teardown() {
  local app="$1"

  log_step "Tearing down droplet ${app}..."

  local meta_file="${LOG_DIR:-/tmp}/${app}.meta"
  if [ ! -f "${meta_file}" ]; then
    log_warn "Metadata file not found: ${meta_file} — cannot delete droplet by ID"
    untrack_app "${app}"
    return 0
  fi

  local droplet_id
  droplet_id=$(jq -r '.id // empty' "${meta_file}" 2>/dev/null || true)

  if [ -z "${droplet_id}" ]; then
    log_warn "Could not extract droplet ID from ${meta_file}"
    untrack_app "${app}"
    return 0
  fi

  # Retry DELETE up to 3 times with --max-time to prevent hangs
  local attempt=0
  local delete_accepted=0
  while [ "${attempt}" -lt 3 ]; do
    attempt=$((attempt + 1))

    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' \
      --max-time 30 \
      -X DELETE \
      -H "Authorization: Bearer ${DO_API_TOKEN}" \
      -H "Content-Type: application/json" \
      "${_DO_API}/droplets/${droplet_id}" 2>/dev/null || printf '000')

    if [ "${http_code}" = "204" ] || [ "${http_code}" = "404" ]; then
      delete_accepted=1
      break
    fi

    if [ "${attempt}" -lt 3 ]; then
      log_warn "Droplet DELETE attempt ${attempt}/3 returned HTTP ${http_code} — retrying in 5s..."
      sleep 5
    else
      log_warn "Droplet DELETE failed after 3 attempts (last HTTP ${http_code}) for ${app} (ID: ${droplet_id})"
    fi
  done

  # Poll to confirm the droplet is actually gone (up to 60s).
  # The API may accept the DELETE (204) but the droplet lingers briefly.
  if [ "${delete_accepted}" -eq 1 ]; then
    local poll_waited=0
    while [ "${poll_waited}" -lt 60 ]; do
      local check_code
      check_code=$(curl -s -o /dev/null -w '%{http_code}' \
        --max-time 10 \
        -H "Authorization: Bearer ${DO_API_TOKEN}" \
        "${_DO_API}/droplets/${droplet_id}" 2>/dev/null || printf '000')

      if [ "${check_code}" = "404" ]; then
        log_ok "Droplet ${app} (ID: ${droplet_id}) confirmed destroyed"
        untrack_app "${app}"
        return 0
      fi

      sleep 5
      poll_waited=$((poll_waited + 5))
    done

    log_warn "Droplet ${app} (ID: ${droplet_id}) not yet gone after 60s — may still be deleting"
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _digitalocean_cleanup_stale
#
# Lists all droplets, filters for names matching e2e-*, extracts the unix
# timestamp from the last dash segment of the name, and destroys any older
# than 30 minutes.
# ---------------------------------------------------------------------------
_digitalocean_cleanup_stale() {
  log_step "Cleaning up stale DigitalOcean e2e droplets..."

  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  local droplets_json
  droplets_json=$(curl -sf \
    -H "Authorization: Bearer ${DO_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "${_DO_API}/droplets?per_page=200" 2>/dev/null || true)

  if [ -z "${droplets_json}" ]; then
    log_info "Could not list DigitalOcean droplets — skipping cleanup"
    return 0
  fi

  # Extract e2e-* droplets as "id name" pairs
  local e2e_droplets
  e2e_droplets=$(printf '%s' "${droplets_json}" | jq -r \
    '.droplets[] | select(.name | startswith("e2e-")) | "\(.id) \(.name)"' 2>/dev/null || true)

  if [ -z "${e2e_droplets}" ]; then
    log_ok "No stale e2e droplets found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  while IFS= read -r line; do
    local droplet_id
    droplet_id=$(printf '%s' "${line}" | cut -d' ' -f1)
    local droplet_name
    droplet_name=$(printf '%s' "${line}" | cut -d' ' -f2)

    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    # The timestamp is the last dash-separated segment
    local ts
    ts=$(printf '%s' "${droplet_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${droplet_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale droplet ${droplet_name} (age: ${age_str})"

      curl -sf -o /dev/null \
        -X DELETE \
        -H "Authorization: Bearer ${DO_API_TOKEN}" \
        -H "Content-Type: application/json" \
        "${_DO_API}/droplets/${droplet_id}" 2>/dev/null || log_warn "Failed to destroy ${droplet_name}"

      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done <<EOF
${e2e_droplets}
EOF

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale droplet(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent droplet(s)"
  fi
}

# ---------------------------------------------------------------------------
# _digitalocean_max_parallel
#
# DigitalOcean accounts often have a 3-droplet limit.
# ---------------------------------------------------------------------------
_digitalocean_max_parallel() {
  printf '3'
}
