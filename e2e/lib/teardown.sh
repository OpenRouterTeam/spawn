#!/bin/bash
# e2e/lib/teardown.sh — Tear down a Fly.io app via REST API
set -eo pipefail

# ---------------------------------------------------------------------------
# teardown_agent APP_NAME
#
# 1. List machines in the app
# 2. Stop each machine
# 3. Delete each machine (force)
# 4. Delete the app
# ---------------------------------------------------------------------------
teardown_agent() {
  local app="$1"

  log_step "Tearing down ${app}..."

  # Get machines list
  local machines_json
  machines_json=$(fly_api GET "/apps/${app}/machines" 2>/dev/null || true)

  if [ -z "${machines_json}" ] || [ "${machines_json}" = "null" ]; then
    log_warn "No machines response for ${app} — attempting app delete anyway"
    fly_api DELETE "/apps/${app}" >/dev/null 2>&1 || true
    untrack_app "${app}"
    return 0
  fi

  # Extract machine IDs
  local machine_ids
  machine_ids=$(printf '%s' "${machines_json}" | jq -r '.[].id // empty' 2>/dev/null || true)

  if [ -n "${machine_ids}" ]; then
    # Stop each machine
    for mid in ${machine_ids}; do
      log_step "Stopping machine ${mid}..."
      fly_api POST "/apps/${app}/machines/${mid}/stop" '{}' >/dev/null 2>&1 || true
    done

    # Brief wait for stop to propagate
    sleep 2

    # Force-delete each machine
    for mid in ${machine_ids}; do
      log_step "Deleting machine ${mid}..."
      fly_api DELETE "/apps/${app}/machines/${mid}?force=true" >/dev/null 2>&1 || true
    done
  fi

  # Delete the app
  log_step "Deleting app ${app}..."
  fly_api DELETE "/apps/${app}" >/dev/null 2>&1 || true

  # Verify deletion
  if flyctl status -a "${app}" >/dev/null 2>&1; then
    log_warn "App ${app} may still exist (flyctl still reports it)"
  else
    log_ok "App ${app} torn down"
  fi

  untrack_app "${app}"
}
