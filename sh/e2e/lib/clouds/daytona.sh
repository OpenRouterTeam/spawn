#!/bin/bash
# e2e/lib/clouds/daytona.sh — Daytona cloud driver for multi-cloud E2E
#
# Implements the standard cloud driver interface (_daytona_* prefixed functions).
# Sourced by common.sh's load_cloud_driver() which wires these to generic names.
#
# Depends on: log_step, log_ok, log_err, log_warn, log_info, format_duration,
#             untrack_app (provided by common.sh)
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_DAYTONA_API_BASE="https://app.daytona.io/api"

# ---------------------------------------------------------------------------
# _daytona_validate_env
#
# Check that DAYTONA_API_KEY is set and valid (test list endpoint).
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_daytona_validate_env() {
  if [ -z "${DAYTONA_API_KEY:-}" ]; then
    log_err "DAYTONA_API_KEY is not set"
    return 1
  fi

  # Validate the key by hitting the sandbox list endpoint
  if ! curl -sf \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox?page=1&limit=1" >/dev/null 2>&1; then
    log_err "DAYTONA_API_KEY is invalid or Daytona API is unreachable"
    return 1
  fi

  log_ok "Daytona API key validated"
  return 0
}

# ---------------------------------------------------------------------------
# _daytona_headless_env APP AGENT
#
# Print export lines to stdout for headless provisioning.
# These are eval'd by the provisioning harness before invoking the CLI.
# ---------------------------------------------------------------------------
_daytona_headless_env() {
  local app="$1"
  # local agent="$2"  # unused but part of the interface

  printf 'export DAYTONA_SANDBOX_NAME="%s"\n' "${app}"
  printf 'export DAYTONA_SANDBOX_SIZE="%s"\n' "${DAYTONA_SANDBOX_SIZE:-small}"
}

# ---------------------------------------------------------------------------
# _daytona_provision_verify APP LOG_DIR
#
# After provisioning, find the sandbox by name, obtain SSH credentials via
# the ssh-access endpoint, and write metadata files for downstream steps.
#
# Writes:
#   $LOG_DIR/$APP.ip    — sentinel value "token-auth" (no traditional IP)
#   $LOG_DIR/$APP.meta  — JSON with id, sshToken, sshHost, sshPort
# ---------------------------------------------------------------------------
_daytona_provision_verify() {
  local app="$1"
  local log_dir="$2"

  # List sandboxes and find the one matching our app name.
  # The API may return a JSON array directly or an object with items/sandboxes.
  local sandboxes_json
  sandboxes_json=$(curl -sf \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox" 2>/dev/null || true)

  if [ -z "${sandboxes_json}" ]; then
    log_err "Failed to list Daytona sandboxes"
    return 1
  fi

  # Extract sandbox ID by matching on name.
  # Handle both array response and object-with-items response.
  local sandbox_id
  sandbox_id=$(printf '%s' "${sandboxes_json}" | jq -r \
    '(if type == "array" then . else (.items // .sandboxes // []) end)
     | map(select(.name == "'"${app}"'"))
     | first
     | .id // empty' 2>/dev/null || true)

  if [ -z "${sandbox_id}" ]; then
    log_err "Sandbox '${app}' not found after provisioning"
    return 1
  fi

  log_ok "Sandbox found: ${sandbox_id}"

  # Request SSH access credentials
  local ssh_json
  ssh_json=$(curl -sf -X POST \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox/${sandbox_id}/ssh-access?expiresInMinutes=480" 2>/dev/null || true)

  if [ -z "${ssh_json}" ]; then
    log_err "Failed to get SSH access for sandbox ${sandbox_id}"
    return 1
  fi

  local ssh_token
  ssh_token=$(printf '%s' "${ssh_json}" | jq -r '.token // empty' 2>/dev/null || true)

  if [ -z "${ssh_token}" ]; then
    log_err "SSH token not found in ssh-access response"
    return 1
  fi

  # Parse host and port from sshCommand (e.g., "ssh -p 2222 TOKEN@HOST" or "ssh TOKEN@HOST")
  local ssh_command
  ssh_command=$(printf '%s' "${ssh_json}" | jq -r '.sshCommand // empty' 2>/dev/null || true)

  local ssh_host="ssh.app.daytona.io"
  local ssh_port=""

  if [ -n "${ssh_command}" ]; then
    # Extract host: last token after @ in the sshCommand
    local host_part
    host_part=$(printf '%s' "${ssh_command}" | sed 's/.*@//')
    if [ -n "${host_part}" ]; then
      ssh_host="${host_part}"
    fi

    # Extract port if -p flag is present
    local port_part
    port_part=$(printf '%s' "${ssh_command}" | sed -n 's/.*-p[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p')
    if [ -n "${port_part}" ]; then
      ssh_port="${port_part}"
    fi
  fi

  log_ok "SSH access ready (host: ${ssh_host}${ssh_port:+, port: ${ssh_port}})"

  # Write sentinel IP file (Daytona uses token-based SSH, not traditional IP)
  printf 'token-auth' > "${log_dir}/${app}.ip"

  # Write metadata file with SSH connection details
  printf '{"id":"%s","sshToken":"%s","sshHost":"%s","sshPort":"%s"}\n' \
    "${sandbox_id}" "${ssh_token}" "${ssh_host}" "${ssh_port}" \
    > "${log_dir}/${app}.meta"

  return 0
}

# ---------------------------------------------------------------------------
# _daytona_read_meta APP
#
# Internal helper: read SSH connection details from the .meta file.
# Sets _DT_ID, _DT_TOKEN, _DT_HOST, _DT_PORT variables.
# Returns 1 if the meta file is missing or unreadable.
# ---------------------------------------------------------------------------
_daytona_read_meta() {
  local app="$1"

  local meta_file="${LOG_DIR:-/tmp}/${app}.meta"
  if [ ! -f "${meta_file}" ]; then
    log_err "Meta file not found: ${meta_file}"
    return 1
  fi

  _DT_ID=$(jq -r '.id // empty' "${meta_file}" 2>/dev/null || true)
  _DT_TOKEN=$(jq -r '.sshToken // empty' "${meta_file}" 2>/dev/null || true)
  _DT_HOST=$(jq -r '.sshHost // empty' "${meta_file}" 2>/dev/null || true)
  _DT_PORT=$(jq -r '.sshPort // empty' "${meta_file}" 2>/dev/null || true)

  if [ -z "${_DT_TOKEN}" ] || [ -z "${_DT_HOST}" ]; then
    log_err "Incomplete SSH credentials in meta file for ${app}"
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# _daytona_exec APP CMD
#
# Run CMD on the Daytona sandbox via SSH using token-based authentication.
# The token serves as the SSH username; PubkeyAuthentication is disabled.
# Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
_daytona_exec() {
  local app="$1"
  local cmd="$2"

  _daytona_read_meta "${app}" || return 1

  local ssh_args=""
  ssh_args="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  ssh_args="${ssh_args} -o PubkeyAuthentication=no -o ConnectTimeout=10"
  ssh_args="${ssh_args} -o LogLevel=ERROR"

  if [ -n "${_DT_PORT}" ]; then
    ssh_args="${ssh_args} -o Port=${_DT_PORT}"
  fi

  # shellcheck disable=SC2086
  ssh ${ssh_args} "${_DT_TOKEN}@${_DT_HOST}" "${cmd}"
}

# ---------------------------------------------------------------------------
# _daytona_exec_long APP CMD TIMEOUT
#
# Same as _daytona_exec but with ServerAliveInterval keep-alives and the
# remote command wrapped in `timeout` for long-running operations.
# ---------------------------------------------------------------------------
_daytona_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout="${3:-120}"

  _daytona_read_meta "${app}" || return 1

  local alive_count=$((timeout / 15 + 1))

  local ssh_args=""
  ssh_args="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
  ssh_args="${ssh_args} -o PubkeyAuthentication=no -o ConnectTimeout=10"
  ssh_args="${ssh_args} -o LogLevel=ERROR"
  ssh_args="${ssh_args} -o ServerAliveInterval=15 -o ServerAliveCountMax=${alive_count}"

  if [ -n "${_DT_PORT}" ]; then
    ssh_args="${ssh_args} -o Port=${_DT_PORT}"
  fi

  # shellcheck disable=SC2086
  ssh ${ssh_args} "${_DT_TOKEN}@${_DT_HOST}" "timeout ${timeout} sh -c '${cmd}'"
}

# ---------------------------------------------------------------------------
# _daytona_teardown APP
#
# Delete the Daytona sandbox by ID (read from .meta file) and untrack it.
# ---------------------------------------------------------------------------
_daytona_teardown() {
  local app="$1"

  log_step "Tearing down ${app}..."

  _daytona_read_meta "${app}" || {
    log_warn "Could not read meta for ${app} — attempting name-based lookup"
    # Fall back to listing sandboxes by name
    local sandboxes_json
    sandboxes_json=$(curl -sf \
      -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
      "${_DAYTONA_API_BASE}/sandbox" 2>/dev/null || true)

    if [ -n "${sandboxes_json}" ]; then
      _DT_ID=$(printf '%s' "${sandboxes_json}" | jq -r \
        '(if type == "array" then . else (.items // .sandboxes // []) end)
         | map(select(.name == "'"${app}"'"))
         | first
         | .id // empty' 2>/dev/null || true)
    fi

    if [ -z "${_DT_ID:-}" ]; then
      log_err "Cannot find sandbox ID for ${app}"
      untrack_app "${app}"
      return 1
    fi
  }

  # Delete the sandbox via API
  curl -sf -X DELETE \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox/${_DT_ID}" >/dev/null 2>&1 || true

  # Brief wait for deletion to propagate
  sleep 2

  # Verify deletion — check if sandbox still exists
  local check_json
  check_json=$(curl -sf \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox/${_DT_ID}" 2>/dev/null || true)

  if [ -n "${check_json}" ]; then
    local state
    state=$(printf '%s' "${check_json}" | jq -r '.state // empty' 2>/dev/null || true)
    if [ -n "${state}" ] && [ "${state}" != "deleted" ] && [ "${state}" != "destroyed" ]; then
      log_warn "Sandbox ${app} (${_DT_ID}) may still exist (state: ${state})"
    else
      log_ok "Sandbox ${app} torn down"
    fi
  else
    log_ok "Sandbox ${app} torn down"
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _daytona_cleanup_stale
#
# List all Daytona sandboxes, filter for e2e-* names, and destroy any
# older than 30 minutes (based on the unix timestamp embedded in the name).
# ---------------------------------------------------------------------------
_daytona_cleanup_stale() {
  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  # Fetch all sandboxes (handle pagination by requesting a large limit)
  local sandboxes_json
  sandboxes_json=$(curl -sf \
    -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
    "${_DAYTONA_API_BASE}/sandbox?page=1&limit=100" 2>/dev/null || true)

  if [ -z "${sandboxes_json}" ]; then
    log_info "Could not list sandboxes or no sandboxes found — skipping cleanup"
    return 0
  fi

  # Extract names and IDs of e2e-* sandboxes as "name:id" pairs
  local e2e_entries
  e2e_entries=$(printf '%s' "${sandboxes_json}" | jq -r \
    '(if type == "array" then . else (.items // .sandboxes // []) end)
     | map(select(.name // "" | startswith("e2e-")))
     | .[]
     | "\(.name):\(.id)"' 2>/dev/null || true)

  if [ -z "${e2e_entries}" ]; then
    log_ok "No stale e2e sandboxes found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  for entry in ${e2e_entries}; do
    local sandbox_name
    sandbox_name=$(printf '%s' "${entry}" | cut -d: -f1)
    local sandbox_id
    sandbox_id=$(printf '%s' "${entry}" | cut -d: -f2-)

    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    # The timestamp is the last dash-separated segment
    local ts
    ts=$(printf '%s' "${sandbox_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${sandbox_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale sandbox ${sandbox_name} (age: ${age_str})"

      curl -sf -X DELETE \
        -H "Authorization: Bearer ${DAYTONA_API_KEY}" \
        "${_DAYTONA_API_BASE}/sandbox/${sandbox_id}" >/dev/null 2>&1 || \
        log_warn "Failed to delete sandbox ${sandbox_name} (${sandbox_id})"

      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale sandbox(es)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent sandbox(es)"
  fi
}
