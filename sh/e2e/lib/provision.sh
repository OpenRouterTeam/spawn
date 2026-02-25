#!/bin/bash
# e2e/lib/provision.sh — Provision an agent VM via spawn CLI (headless)
set -eo pipefail

# ---------------------------------------------------------------------------
# provision_agent AGENT APP_NAME LOG_DIR
#
# Runs spawn in headless mode with a timeout. The provision process hangs on
# the interactive SSH session (step 12 of the orchestration), so we kill it
# after PROVISION_TIMEOUT seconds. The install itself usually succeeds; we
# verify via app existence and .spawnrc presence afterward.
# ---------------------------------------------------------------------------
provision_agent() {
  local agent="$1"
  local app_name="$2"
  local log_dir="$3"

  local exit_file="${log_dir}/${agent}.exit"
  local stdout_file="${log_dir}/${agent}.stdout"
  local stderr_file="${log_dir}/${agent}.stderr"

  # Resolve CLI entry point (relative to this script's location in sh/e2e/lib/)
  local cli_entry
  cli_entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/packages/cli/src/index.ts"

  if [ ! -f "${cli_entry}" ]; then
    log_err "CLI entry point not found: ${cli_entry}"
    return 1
  fi

  log_step "Provisioning ${agent} as ${app_name} (timeout: ${PROVISION_TIMEOUT}s)"

  # Remove stale exit file
  rm -f "${exit_file}"

  # Environment for headless provisioning
  # FLY_API_TOKEN="" forces spawn to use flyctl stored credentials (see plan section 6)
  # MODEL_ID bypasses the interactive model selection prompt (required by openclaw)
  #
  # Validate flyctl is authenticated before proceeding with empty token fallback
  if [ -z "${FLY_API_TOKEN:-}" ]; then
    if ! flyctl auth whoami >/dev/null 2>&1; then
      log_err "FLY_API_TOKEN is empty and flyctl is not authenticated. Run: flyctl auth login"
      return 1
    fi
  fi
  (
    SPAWN_NON_INTERACTIVE=1 \
    SPAWN_SKIP_GITHUB_AUTH=1 \
    SPAWN_SKIP_API_VALIDATION=1 \
    MODEL_ID="${MODEL_ID:-openrouter/auto}" \
    FLY_APP_NAME="${app_name}" \
    FLY_REGION="${FLY_REGION}" \
    FLY_VM_MEMORY="${FLY_VM_MEMORY}" \
    FLY_API_TOKEN="" \
    OPENROUTER_API_KEY="${OPENROUTER_API_KEY}" \
    bun run "${cli_entry}" "${agent}" fly --headless --output json \
      > "${stdout_file}" 2> "${stderr_file}"
    printf '%s' "$?" > "${exit_file}"
  ) &
  local pid=$!

  # Poll for completion or timeout (bash 3.2 compatible — no wait -n)
  local waited=0
  while [ "${waited}" -lt "${PROVISION_TIMEOUT}" ]; do
    if [ -f "${exit_file}" ]; then
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done

  # Kill if still running (the interactive SSH session hangs)
  if [ ! -f "${exit_file}" ]; then
    log_warn "Provision timed out after ${PROVISION_TIMEOUT}s — killing (install may still succeed)"
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  fi

  # Check if the provision process exited cleanly
  local exit_code=""
  if [ -f "${exit_file}" ]; then
    exit_code=$(cat "${exit_file}")
  fi

  # Even if provision "failed" (timeout), the app may exist and install may have completed.
  # Verify app existence via flyctl + REST API fallback.
  local app_exists=0
  if flyctl status -a "${app_name}" >/dev/null 2>&1; then
    app_exists=1
  else
    # REST API fallback
    local api_result
    api_result=$(fly_api GET "/apps/${app_name}/machines" 2>/dev/null || true)
    if printf '%s' "${api_result}" | jq -e '.[0].id' >/dev/null 2>&1; then
      app_exists=1
    fi
  fi

  if [ "${app_exists}" -eq 0 ]; then
    log_err "App ${app_name} does not exist after provisioning"
    if [ -f "${stderr_file}" ]; then
      log_err "Stderr tail:"
      tail -20 "${stderr_file}" >&2 || true
    fi
    return 1
  fi

  log_ok "App ${app_name} exists"

  # Wait for install to complete (.spawnrc is written near the end)
  log_step "Waiting for install to complete (polling .spawnrc, up to ${INSTALL_WAIT}s)..."
  local install_waited=0
  local install_ok=0
  while [ "${install_waited}" -lt "${INSTALL_WAIT}" ]; do
    if fly_ssh "${app_name}" "test -f ~/.spawnrc" >/dev/null 2>&1; then
      install_ok=1
      break
    fi
    sleep 10
    install_waited=$((install_waited + 10))
  done

  if [ "${install_ok}" -eq 1 ]; then
    # Settle time for agent binary install to finish after .spawnrc is written
    sleep 5
    log_ok "Install completed (.spawnrc found)"
    return 0
  else
    log_warn ".spawnrc not found after ${INSTALL_WAIT}s — install may still be running"
    return 0  # Continue to verification; it will catch real failures
  fi
}
