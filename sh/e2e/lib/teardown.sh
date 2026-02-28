#!/bin/bash
# e2e/lib/teardown.sh — Tear down a cloud instance (cloud-agnostic)
set -eo pipefail

# ---------------------------------------------------------------------------
# teardown_agent APP_NAME
#
# Delegates to the active cloud driver's teardown function.
# ---------------------------------------------------------------------------
teardown_agent() {
  local app="$1"

  log_step "Tearing down ${app} on ${ACTIVE_CLOUD}..."
  cloud_teardown "${app}"
}
