#!/bin/bash
# e2e/lib/cleanup.sh — Find and destroy stale e2e-* Lightsail instances
set -eo pipefail

# ---------------------------------------------------------------------------
# cleanup_stale_apps
#
# Lists all Lightsail instances, filters for e2e-* pattern, and tears down any
# older than 30 minutes (based on the unix timestamp embedded in the name).
# ---------------------------------------------------------------------------
cleanup_stale_apps() {
  log_header "Cleaning up stale e2e instances"

  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  # List all instances via AWS CLI
  local instances_json
  instances_json=$(aws lightsail get-instances \
    --region "${AWS_REGION}" \
    --query 'instances[].name' \
    --output json 2>/dev/null || true)

  if [ -z "${instances_json}" ] || [ "${instances_json}" = "null" ] || [ "${instances_json}" = "[]" ]; then
    log_info "Could not list instances or no instances found — skipping cleanup"
    return 0
  fi

  # Extract instance names matching e2e-* pattern
  local instance_names
  instance_names=$(printf '%s' "${instances_json}" | jq -r '.[]? // empty' 2>/dev/null | grep '^e2e-' || true)

  if [ -z "${instance_names}" ]; then
    log_ok "No stale e2e instances found"
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
      log_step "Destroying stale instance ${instance_name} (age: ${age_str})"
      teardown_agent "${instance_name}" || log_warn "Failed to tear down ${instance_name}"
      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale instance(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent instance(s)"
  fi
}
