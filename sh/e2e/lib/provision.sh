#!/bin/bash
# e2e/lib/provision.sh — Provision an agent VM via spawn CLI on AWS Lightsail (headless)
set -eo pipefail

# ---------------------------------------------------------------------------
# provision_agent AGENT APP_NAME LOG_DIR
#
# Runs spawn in headless mode with a timeout. The provision process hangs on
# the interactive SSH session (step 12 of the orchestration), so we kill it
# after PROVISION_TIMEOUT seconds. The install itself usually succeeds; we
# verify via instance existence and .spawnrc presence afterward.
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
  # MODEL_ID bypasses the interactive model selection prompt (required by openclaw)
  (
    export SPAWN_NON_INTERACTIVE=1
    export SPAWN_SKIP_GITHUB_AUTH=1
    export SPAWN_SKIP_API_VALIDATION=1
    export MODEL_ID="${MODEL_ID:-openrouter/auto}"
    export AWS_LIGHTSAIL_INSTANCE_NAME="${app_name}"
    export AWS_REGION="${AWS_REGION}"
    export AWS_BUNDLE="${AWS_BUNDLE}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"

    bun run "${cli_entry}" "${agent}" aws --headless --output json \
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

  # Even if provision "failed" (timeout), the instance may exist and install may have completed.
  # Verify instance existence via AWS CLI.
  local app_exists=0
  if aws lightsail get-instance --instance-name "${app_name}" --region "${AWS_REGION}" >/dev/null 2>&1; then
    app_exists=1
  fi

  if [ "${app_exists}" -eq 0 ]; then
    log_err "Instance ${app_name} does not exist after provisioning"
    if [ -f "${stderr_file}" ]; then
      log_err "Stderr tail:"
      tail -20 "${stderr_file}" >&2 || true
    fi
    return 1
  fi

  log_ok "Instance ${app_name} exists"

  # Resolve instance public IP
  local instance_ip
  instance_ip=$(aws lightsail get-instance \
    --instance-name "${app_name}" \
    --region "${AWS_REGION}" \
    --query 'instance.publicIpAddress' \
    --output text 2>/dev/null || true)

  if [ -z "${instance_ip}" ] || [ "${instance_ip}" = "None" ]; then
    log_err "Could not resolve public IP for ${app_name}"
    return 1
  fi

  log_ok "Instance IP: ${instance_ip}"

  # Store IP in a file for verify/teardown to read
  printf '%s' "${instance_ip}" > "${log_dir}/${app_name}.ip"

  # Wait for install to complete (.spawnrc is written near the end)
  log_step "Waiting for install to complete (polling .spawnrc, up to ${INSTALL_WAIT}s)..."
  local install_waited=0
  local install_ok=0
  while [ "${install_waited}" -lt "${INSTALL_WAIT}" ]; do
    if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 \
         -o LogLevel=ERROR -o BatchMode=yes \
         "ubuntu@${instance_ip}" "test -f ~/.spawnrc" >/dev/null 2>&1; then
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
