#!/bin/bash
# e2e/lib/clouds/hetzner.sh — Hetzner Cloud driver for multi-cloud E2E tests
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_HETZNER_API="https://api.hetzner.cloud/v1"

# ---------------------------------------------------------------------------
# _hetzner_validate_env
#
# Verify HCLOUD_TOKEN is set and credentials are valid.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_hetzner_validate_env() {
  if [ -z "${HCLOUD_TOKEN:-}" ]; then
    log_err "HCLOUD_TOKEN is not set"
    return 1
  fi

  if ! curl -sf \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    "${_HETZNER_API}/servers?per_page=1" >/dev/null 2>&1; then
    log_err "Hetzner API credentials are invalid"
    return 1
  fi

  log_ok "Hetzner credentials validated"
  return 0
}

# ---------------------------------------------------------------------------
# _hetzner_headless_env APP AGENT
#
# Print export lines for headless provisioning to stdout.
# ---------------------------------------------------------------------------
_hetzner_headless_env() {
  local app="$1"
  # $2 = agent (unused but part of the interface)

  printf 'export HETZNER_SERVER_NAME="%s"\n' "${app}"
  printf 'export HETZNER_SERVER_TYPE="%s"\n' "${HETZNER_SERVER_TYPE:-cx22}"
  printf 'export HETZNER_LOCATION="%s"\n' "${HETZNER_LOCATION:-fsn1}"
}

# ---------------------------------------------------------------------------
# _hetzner_provision_verify APP LOG_DIR
#
# Verify the server exists via Hetzner API. Extract ID and IP.
# Write IP to $LOG_DIR/$APP.ip and metadata to $LOG_DIR/$APP.meta.
# ---------------------------------------------------------------------------
_hetzner_provision_verify() {
  local app="$1"
  local log_dir="$2"

  local response
  response=$(curl -sf \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    "${_HETZNER_API}/servers?name=${app}" 2>/dev/null || true)

  if [ -z "${response}" ]; then
    log_err "Failed to query Hetzner API for server ${app}"
    return 1
  fi

  local server_count
  server_count=$(printf '%s' "${response}" | jq '.servers | length' 2>/dev/null || printf '0')

  if [ "${server_count}" -eq 0 ]; then
    log_err "Server ${app} does not exist on Hetzner"
    return 1
  fi

  local server_id
  server_id=$(printf '%s' "${response}" | jq -r '.servers[0].id' 2>/dev/null)

  local server_ip
  server_ip=$(printf '%s' "${response}" | jq -r '.servers[0].public_net.ipv4.ip // empty' 2>/dev/null)

  if [ -z "${server_ip}" ]; then
    log_err "Could not resolve public IP for ${app}"
    return 1
  fi

  local server_name
  server_name=$(printf '%s' "${response}" | jq -r '.servers[0].name' 2>/dev/null)

  local server_location
  server_location=$(printf '%s' "${response}" | jq -r '.servers[0].datacenter.location.name // "unknown"' 2>/dev/null)

  # Write IP for SSH access
  printf '%s' "${server_ip}" > "${log_dir}/${app}.ip"

  # Write metadata for teardown
  printf '{"id":%s,"name":"%s","location":"%s"}\n' \
    "${server_id}" "${server_name}" "${server_location}" \
    > "${log_dir}/${app}.meta"

  log_ok "Server ${app} verified (id=${server_id}, ip=${server_ip}, location=${server_location})"
  return 0
}

# ---------------------------------------------------------------------------
# _hetzner_exec APP CMD
#
# Execute a command on the server via SSH.
# ---------------------------------------------------------------------------
_hetzner_exec() {
  local app="$1"
  local cmd="$2"
  local log_dir="${LOG_DIR:-/tmp}"

  local ip_file="${log_dir}/${app}.ip"
  if [ ! -f "${ip_file}" ]; then
    log_err "No IP file found for ${app} at ${ip_file}"
    return 1
  fi

  local ip
  ip=$(cat "${ip_file}")

  ssh -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      "root@${ip}" "${cmd}"
}

# ---------------------------------------------------------------------------
# _hetzner_exec_long APP CMD TIMEOUT
#
# Execute a long-running command on the server via SSH with keepalive
# and a remote-side timeout.
# ---------------------------------------------------------------------------
_hetzner_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout_secs="$3"
  local log_dir="${LOG_DIR:-/tmp}"

  local ip_file="${log_dir}/${app}.ip"
  if [ ! -f "${ip_file}" ]; then
    log_err "No IP file found for ${app} at ${ip_file}"
    return 1
  fi

  local ip
  ip=$(cat "${ip_file}")

  ssh -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR \
      -o BatchMode=yes \
      -o ConnectTimeout=10 \
      -o ServerAliveInterval=15 \
      "root@${ip}" "timeout ${timeout_secs} sh -c '${cmd}'"
}

# ---------------------------------------------------------------------------
# _hetzner_teardown APP
#
# Delete the server via Hetzner API using the stored server ID.
# ---------------------------------------------------------------------------
_hetzner_teardown() {
  local app="$1"
  local log_dir="${LOG_DIR:-/tmp}"

  local meta_file="${log_dir}/${app}.meta"
  if [ ! -f "${meta_file}" ]; then
    log_warn "No metadata file for ${app} — cannot determine server ID"
    untrack_app "${app}"
    return 0
  fi

  local server_id
  server_id=$(jq -r '.id' "${meta_file}" 2>/dev/null)

  if [ -z "${server_id}" ] || [ "${server_id}" = "null" ]; then
    log_warn "Could not parse server ID from ${meta_file}"
    untrack_app "${app}"
    return 0
  fi

  log_step "Deleting Hetzner server ${app} (id=${server_id})"

  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' \
    -X DELETE \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    "${_HETZNER_API}/servers/${server_id}" 2>/dev/null || printf '000')

  if [ "${http_code}" = "200" ] || [ "${http_code}" = "204" ]; then
    log_ok "Server ${app} (id=${server_id}) deleted"
  elif [ "${http_code}" = "404" ]; then
    log_info "Server ${app} (id=${server_id}) already gone"
  else
    log_warn "Unexpected HTTP ${http_code} deleting server ${app} (id=${server_id})"
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _hetzner_cleanup_stale
#
# List all Hetzner servers, find e2e-* instances older than 30 minutes,
# and destroy them.
# ---------------------------------------------------------------------------
_hetzner_cleanup_stale() {
  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes

  local response
  response=$(curl -sf \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    "${_HETZNER_API}/servers?per_page=50" 2>/dev/null || true)

  if [ -z "${response}" ]; then
    log_info "Could not list Hetzner servers — skipping cleanup"
    return 0
  fi

  local server_count
  server_count=$(printf '%s' "${response}" | jq '.servers | length' 2>/dev/null || printf '0')

  if [ "${server_count}" -eq 0 ]; then
    log_ok "No Hetzner servers found"
    return 0
  fi

  # Extract e2e-* servers as "id:name" pairs
  local servers
  servers=$(printf '%s' "${response}" | jq -r '.servers[] | select(.name | startswith("e2e-")) | "\(.id):\(.name)"' 2>/dev/null || true)

  if [ -z "${servers}" ]; then
    log_ok "No stale e2e instances found on Hetzner"
    return 0
  fi

  local cleaned=0
  local skipped=0

  for entry in ${servers}; do
    local server_id
    server_id=$(printf '%s' "${entry}" | cut -d: -f1)

    local server_name
    server_name=$(printf '%s' "${entry}" | cut -d: -f2-)

    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    local ts
    ts=$(printf '%s' "${server_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${server_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale Hetzner server ${server_name} (id=${server_id}, age: ${age_str})"

      local http_code
      http_code=$(curl -s -o /dev/null -w '%{http_code}' \
        -X DELETE \
        -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
        "${_HETZNER_API}/servers/${server_id}" 2>/dev/null || printf '000')

      if [ "${http_code}" = "200" ] || [ "${http_code}" = "204" ]; then
        log_ok "Deleted ${server_name}"
      elif [ "${http_code}" = "404" ]; then
        log_info "Server ${server_name} already gone"
      else
        log_warn "Failed to delete ${server_name} (HTTP ${http_code})"
      fi

      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale Hetzner instance(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent Hetzner instance(s)"
  fi
}
