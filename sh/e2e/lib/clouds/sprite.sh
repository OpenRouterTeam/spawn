#!/bin/bash
# e2e/lib/clouds/sprite.sh — Sprite cloud driver for multi-cloud E2E
#
# Implements the standard cloud driver interface (_sprite_* prefixed functions).
# Sourced by common.sh's load_cloud_driver() which wires these to generic names.
#
# Sprite uses its own CLI for execution — NO SSH is used.
# All remote commands run via: sprite exec -s NAME -- bash -c '$1' _ "CMD"
#
# Depends on: log_step, log_ok, log_err, log_warn, log_info, format_duration,
#             untrack_app (provided by common.sh)
set -eo pipefail

# Detected org — set during _sprite_validate_env.
# Passed as -o flag to all sprite CLI calls to avoid config file races
# from concurrent sprite exec calls corrupting ~/.sprites/sprites.json.
_SPRITE_ORG=""

# Helper: build org flags array for sprite CLI calls
_sprite_org_flags() {
  if [ -n "${_SPRITE_ORG}" ]; then
    printf '%s' "-o ${_SPRITE_ORG}"
  fi
}

# Helper: fix corrupted sprite config (double-closing-brace from concurrent writes)
_sprite_fix_config() {
  local cfg="${HOME}/.sprites/sprites.json"
  if [ -f "${cfg}" ]; then
    # Check for double-brace corruption (most common race condition pattern).
    # The sprite CLI's concurrent writes append an extra } at the end.
    # Use grep on the whole file for any line that is just }}
    if grep -q '^}}$' "${cfg}" 2>/dev/null; then
      local tmp="${cfg}.fix$$"
      sed 's/^}}$/}/' "${cfg}" > "${tmp}" 2>/dev/null && mv "${tmp}" "${cfg}" 2>/dev/null || rm -f "${tmp}"
    fi
    # Also check if last non-empty line ends with }}
    local last_content
    last_content=$(tail -5 "${cfg}" | grep -v '^$' | tail -1)
    if printf '%s' "${last_content}" | grep -q '}}$'; then
      local tmp="${cfg}.fix$$"
      # Replace the LAST occurrence of }} with }
      sed '$ s/}}$/}/' "${cfg}" > "${tmp}" 2>/dev/null && mv "${tmp}" "${cfg}" 2>/dev/null || rm -f "${tmp}"
    fi
  fi
}

# ---------------------------------------------------------------------------
# _sprite_max_parallel
#
# Sprite CLI gets rate-limited with too many concurrent calls.
# Cap to 2 agents at a time.
# ---------------------------------------------------------------------------
_sprite_max_parallel() {
  printf '1'
}

# ---------------------------------------------------------------------------
# _sprite_install_wait
#
# Sprite exec is slower per-call than SSH — give installs more time to complete.
# ---------------------------------------------------------------------------
_sprite_install_wait() {
  printf '300'
}

# ---------------------------------------------------------------------------
# _sprite_validate_env
#
# Check that the sprite CLI is installed and credentials are valid.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_sprite_validate_env() {
  if ! command -v sprite >/dev/null 2>&1; then
    log_err "sprite CLI not found. Install from https://docs.sprite.dev"
    return 1
  fi

  local org_output
  org_output=$(sprite org list 2>/dev/null || true)
  if [ -z "${org_output}" ]; then
    log_err "Sprite credentials are not valid. Run: sprite auth login"
    return 1
  fi

  # Extract org name and cache it — all subsequent sprite CLI calls use -o flag
  # to avoid concurrent config file reads/writes corrupting sprites.json
  _SPRITE_ORG=$(printf '%s' "${org_output}" | sed -n 's/.*Currently selected org: *//p' | awk '{print $1}')
  if [ -z "${_SPRITE_ORG}" ]; then
    # Fallback: try SPRITE_ORG env var
    _SPRITE_ORG="${SPRITE_ORG:-}"
  fi

  if [ -n "${_SPRITE_ORG}" ]; then
    log_ok "Sprite credentials validated (org: ${_SPRITE_ORG})"
  else
    log_ok "Sprite credentials validated"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# _sprite_headless_env APP AGENT
#
# Print export lines to stdout for headless provisioning.
# These are eval'd by the provisioning harness before invoking the CLI.
# ---------------------------------------------------------------------------
_sprite_headless_env() {
  local app="$1"
  # local agent="$2"  # unused but part of the interface

  printf 'export SPRITE_NAME="%s"\n' "${app}"
  if [ -n "${_SPRITE_ORG}" ]; then
    printf 'export SPRITE_ORG="%s"\n' "${_SPRITE_ORG}"
  fi
}

# ---------------------------------------------------------------------------
# _sprite_provision_verify APP LOG_DIR
#
# Verify sprite VM exists after provisioning by checking `sprite list` output
# for the APP name. Write sentinel and metadata files for downstream steps.
#
# Writes:
#   $LOG_DIR/$APP.ip    — "sprite-cli" sentinel (no IP — Sprite uses names)
#   $LOG_DIR/$APP.meta  — instance metadata (JSON)
# ---------------------------------------------------------------------------
_sprite_provision_verify() {
  local app="$1"
  local log_dir="$2"

  # Check instance exists in sprite list
  _sprite_fix_config
  local sprite_output
  # shellcheck disable=SC2046
  sprite_output=$(sprite $(_sprite_org_flags) list 2>/dev/null || true)

  if [ -z "${sprite_output}" ]; then
    log_err "Could not list Sprite instances"
    return 1
  fi

  if ! printf '%s' "${sprite_output}" | grep -q "${app}"; then
    log_err "Sprite instance ${app} not found in sprite list"
    return 1
  fi

  log_ok "Sprite instance ${app} exists"

  # Write sentinel — Sprite has no IP; use "sprite-cli" as marker
  printf '%s' "sprite-cli" > "${log_dir}/${app}.ip"

  # Write metadata file
  printf '{"name":"%s"}\n' "${app}" > "${log_dir}/${app}.meta"

  return 0
}

# ---------------------------------------------------------------------------
# _sprite_exec APP CMD
#
# Execute CMD on the Sprite instance via the sprite CLI.
# Uses direct command embedding (not $1 positional) so tilde expansion
# and compound operators (&&, ||) work correctly on the remote side.
# Retries up to 3 times when the sprite CLI itself fails (config corruption).
# Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
_sprite_exec() {
  local app="$1"
  local cmd="$2"
  local _attempt=0
  local _max=3
  local _stderr_tmp="/tmp/sprite-exec-err.$$"

  while [ "${_attempt}" -lt "${_max}" ]; do
    _sprite_fix_config
    # shellcheck disable=SC2046
    sprite $(_sprite_org_flags) exec -s "${app}" -- bash -c "${cmd}" 2>"${_stderr_tmp}"
    local _rc=$?
    if [ "${_rc}" -eq 0 ]; then
      rm -f "${_stderr_tmp}"
      return 0
    fi
    # Retry on sprite CLI errors (config corruption, connection issues)
    if grep -qiE 'config|migrate|initialize|connection refused' "${_stderr_tmp}" 2>/dev/null; then
      _attempt=$((_attempt + 1))
      if [ "${_attempt}" -lt "${_max}" ]; then
        sleep 2
        continue
      fi
    fi
    rm -f "${_stderr_tmp}"
    return "${_rc}"
  done
  rm -f "${_stderr_tmp}"
}

# ---------------------------------------------------------------------------
# _sprite_exec_long APP CMD TIMEOUT
#
# Same as _sprite_exec but wraps the remote command in `timeout` for
# long-running operations. Retries on sprite CLI errors.
# ---------------------------------------------------------------------------
_sprite_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout="${3:-120}"
  local _attempt=0
  local _max=3
  local _stderr_tmp="/tmp/sprite-execl-err.$$"

  while [ "${_attempt}" -lt "${_max}" ]; do
    _sprite_fix_config
    # shellcheck disable=SC2046
    sprite $(_sprite_org_flags) exec -s "${app}" -- bash -c "timeout ${timeout} bash -c '${cmd}'" 2>"${_stderr_tmp}"
    local _rc=$?
    if [ "${_rc}" -eq 0 ]; then
      rm -f "${_stderr_tmp}"
      return 0
    fi
    if grep -qiE 'config|migrate|initialize|connection refused' "${_stderr_tmp}" 2>/dev/null; then
      _attempt=$((_attempt + 1))
      if [ "${_attempt}" -lt "${_max}" ]; then
        sleep 2
        continue
      fi
    fi
    rm -f "${_stderr_tmp}"
    return "${_rc}"
  done
  rm -f "${_stderr_tmp}"
}

# ---------------------------------------------------------------------------
# _sprite_teardown APP
#
# Destroy the Sprite instance and untrack it.
# ---------------------------------------------------------------------------
_sprite_teardown() {
  local app="$1"

  log_step "Tearing down ${app}..."

  # shellcheck disable=SC2046
  sprite $(_sprite_org_flags) destroy "${app}" >/dev/null 2>&1 || true

  # Brief wait for destruction to propagate
  sleep 2

  # Verify deletion
  local sprite_output
  # shellcheck disable=SC2046
  sprite_output=$(sprite $(_sprite_org_flags) list 2>/dev/null || true)

  if printf '%s' "${sprite_output}" | grep -q "${app}"; then
    log_warn "Sprite instance ${app} may still exist"
  else
    log_ok "Sprite instance ${app} torn down"
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _sprite_cleanup_stale
#
# List all Sprite instances, filter for e2e-* names, and destroy any
# older than 30 minutes (based on the unix timestamp embedded in the name).
# ---------------------------------------------------------------------------
_sprite_cleanup_stale() {
  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  # List all sprites
  local sprite_output
  # shellcheck disable=SC2046
  sprite_output=$(sprite $(_sprite_org_flags) list 2>/dev/null || true)

  if [ -z "${sprite_output}" ]; then
    log_info "Could not list Sprite instances or none found — skipping cleanup"
    return 0
  fi

  # Extract names matching e2e-* pattern (one per line)
  local instance_names
  instance_names=$(printf '%s\n' "${sprite_output}" | grep -oE 'e2e-[a-zA-Z0-9_-]+' || true)

  if [ -z "${instance_names}" ]; then
    log_ok "No stale e2e Sprite instances found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  for instance_name in ${instance_names}; do
    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    # The timestamp is the last dash-separated segment
    local ts
    ts=$(printf '%s' "${instance_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${instance_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale Sprite instance ${instance_name} (age: ${age_str})"
      _sprite_teardown "${instance_name}" || log_warn "Failed to tear down ${instance_name}"
      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale Sprite instance(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent Sprite instance(s)"
  fi
}
