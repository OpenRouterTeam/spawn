#!/bin/bash
# e2e/lib/teardown.sh — Tear down an AWS Lightsail instance
set -eo pipefail

# ---------------------------------------------------------------------------
# teardown_agent APP_NAME
#
# 1. Delete the Lightsail instance (with --force-delete-add-ons)
# 2. Verify deletion
# ---------------------------------------------------------------------------
teardown_agent() {
  local app="$1"

  log_step "Tearing down ${app}..."

  # Delete the instance
  aws lightsail delete-instance \
    --instance-name "${app}" \
    --region "${AWS_REGION}" \
    --force-delete-add-ons \
    >/dev/null 2>&1 || true

  # Brief wait for deletion to propagate
  sleep 2

  # Verify deletion
  if aws lightsail get-instance --instance-name "${app}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    log_warn "Instance ${app} may still exist (AWS still reports it)"
  else
    log_ok "Instance ${app} torn down"
  fi

  untrack_app "${app}"
}
