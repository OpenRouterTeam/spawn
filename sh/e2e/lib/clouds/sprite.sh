#!/bin/bash
# e2e/lib/clouds/sprite.sh — Sprite cloud driver for multi-cloud E2E
#
# Implements the standard cloud driver interface (_sprite_* prefixed functions).
# Sourced by common.sh's load_cloud_driver() which wires these to generic names.
#
# Sprite uses its own CLI for execution — NO SSH is used.
# All remote commands run via: sprite exec -s NAME -- bash -c "CMD"
#
# Depends on: log_step, log_ok, log_err, log_warn, log_info, format_duration,
#             untrack_app (provided by common.sh)
set -eo pipefail

# ---------------------------------------------------------------------------
# _sprite_max_parallel
#
# Sprite CLI gets rate-limited with too many concurrent calls.
# Cap to 2 agents at a time.
# ---------------------------------------------------------------------------
_sprite_max_parallel() {
  printf '2'
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

  if ! sprite org list >/dev/null 2>&1; then
    log_err "Sprite credentials are not valid. Run: sprite auth login"
    return 1
  fi

  log_ok "Sprite credentials validated"
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
  local sprite_output
  sprite_output=$(sprite list 2>/dev/null || true)

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
# Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
_sprite_exec() {
  local app="$1"
  local cmd="$2"

  sprite exec -s "${app}" -- bash -c "${cmd}"
}

# ---------------------------------------------------------------------------
# _sprite_exec_long APP CMD TIMEOUT
#
# Same as _sprite_exec but wraps the remote command in `timeout` for
# long-running operations.
# ---------------------------------------------------------------------------
_sprite_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout="${3:-120}"

  sprite exec -s "${app}" -- bash -c "timeout ${timeout} bash -c '${cmd}'"
}

# ---------------------------------------------------------------------------
# _sprite_teardown APP
#
# Destroy the Sprite instance and untrack it.
# ---------------------------------------------------------------------------
_sprite_teardown() {
  local app="$1"

  log_step "Tearing down ${app}..."

  sprite destroy "${app}" >/dev/null 2>&1 || true

  # Brief wait for destruction to propagate
  sleep 2

  # Verify deletion
  local sprite_output
  sprite_output=$(sprite list 2>/dev/null || true)

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
  sprite_output=$(sprite list 2>/dev/null || true)

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
