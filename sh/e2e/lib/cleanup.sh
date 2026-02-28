#!/bin/bash
# e2e/lib/cleanup.sh — Find and destroy stale e2e-* instances (cloud-agnostic)
set -eo pipefail

# ---------------------------------------------------------------------------
# cleanup_stale_apps
#
# Delegates to the active cloud driver's stale cleanup function.
# ---------------------------------------------------------------------------
cleanup_stale_apps() {
  log_header "Cleaning up stale e2e instances (${ACTIVE_CLOUD})"
  cloud_cleanup_stale
}
