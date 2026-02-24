#!/bin/bash
# e2e/lib/cleanup.sh — Find and destroy stale e2e-* apps
set -eo pipefail

# ---------------------------------------------------------------------------
# cleanup_stale_apps
#
# Lists all apps in the org, filters for e2e-* pattern, and tears down any
# older than 30 minutes (based on the unix timestamp embedded in the name).
# ---------------------------------------------------------------------------
cleanup_stale_apps() {
  log_header "Cleaning up stale e2e apps"

  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  # List all apps via REST API
  local apps_json
  apps_json=$(fly_api GET "/apps?org_slug=personal" 2>/dev/null || true)

  if [ -z "${apps_json}" ] || [ "${apps_json}" = "null" ]; then
    log_info "Could not list apps — skipping cleanup"
    return 0
  fi

  # Extract app names matching e2e-* pattern
  local app_names
  app_names=$(printf '%s' "${apps_json}" | jq -r '.apps[]?.name // empty' 2>/dev/null | grep '^e2e-' || true)

  if [ -z "${app_names}" ]; then
    log_ok "No stale e2e apps found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  for app_name in ${app_names}; do
    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    # The timestamp is the last dash-separated segment
    local ts
    ts=$(printf '%s' "${app_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${app_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale app ${app_name} (age: ${age_str})"
      teardown_agent "${app_name}" || log_warn "Failed to tear down ${app_name}"
      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale app(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent app(s)"
  fi
}
