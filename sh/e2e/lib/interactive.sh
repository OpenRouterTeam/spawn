#!/bin/bash
# e2e/lib/interactive.sh — AI-driven interactive provision & verification
#
# Instead of running spawn in headless mode (SPAWN_NON_INTERACTIVE=1), this
# runs spawn interactively with an AI agent (Claude Haiku) responding to
# prompts like a human user would. Tests the real user experience end-to-end.
#
# Requires: ANTHROPIC_API_KEY (for the AI driver), plus normal cloud creds.
set -eo pipefail

# ---------------------------------------------------------------------------
# interactive_provision AGENT APP_NAME LOG_DIR
#
# Runs spawn interactively with AI driving the prompts. On success, the
# instance is provisioned AND the agent is installed — equivalent to
# provision_agent + verify_agent in the headless flow.
#
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
interactive_provision() {
  local agent="$1"
  local app_name="$2"
  local log_dir="$3"

  # Validate app_name (same rules as provision.sh)
  if [ -z "${app_name}" ] || ! printf '%s' "${app_name}" | grep -qE '^[A-Za-z0-9._-]+$'; then
    log_err "Invalid app_name: must be non-empty and contain only [A-Za-z0-9._-]"
    return 1
  fi

  # Require AI driver key
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    log_err "ANTHROPIC_API_KEY required for interactive mode"
    return 1
  fi

  # Resolve harness script
  local harness_script
  harness_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/interactive-harness.ts"
  if [ ! -f "${harness_script}" ]; then
    log_err "Interactive harness not found: ${harness_script}"
    return 1
  fi

  local result_file="${log_dir}/${app_name}-interactive.json"
  local log_file="${log_dir}/${app_name}-interactive.log"

  log_step "Interactive provision: ${agent} on ${ACTIVE_CLOUD}"
  log_info "AI driver: Claude Haiku via Anthropic API"

  # Build cloud-specific env for the spawn CLI invocation.
  # The harness inherits the current env, which already has cloud creds
  # loaded by the cloud driver. We just need to set spawn-specific vars.
  local spawn_env=""
  spawn_env="${spawn_env} SPAWN_NAME_KEBAB=${app_name}"

  # Map ACTIVE_CLOUD to the cloud name spawn expects
  local spawn_cloud="${ACTIVE_CLOUD}"

  local harness_start
  harness_start=$(date +%s)

  # Run the harness — it outputs JSON to stdout, logs to stderr
  local harness_exit=0
  env ${spawn_env} bun run "${harness_script}" "${agent}" "${spawn_cloud}" \
    > "${result_file}" 2> "${log_file}" || harness_exit=$?

  local harness_end
  harness_end=$(date +%s)
  local harness_duration=$((harness_end - harness_start))

  # Parse result
  if [ -f "${result_file}" ] && [ -s "${result_file}" ]; then
    local harness_success
    harness_success=$(jq -r '.success // false' "${result_file}" 2>/dev/null || printf 'false')
    local harness_turns
    harness_turns=$(jq -r '.turns // 0' "${result_file}" 2>/dev/null || printf '0')
    local harness_reason
    harness_reason=$(jq -r '.failReason // ""' "${result_file}" 2>/dev/null || printf '')

    if [ "${harness_success}" = "true" ]; then
      log_ok "Interactive provision succeeded (${harness_duration}s, ${harness_turns} AI turns)"

      # Now verify the instance exists via cloud driver so teardown works
      if cloud_provision_verify "${app_name}" "${log_dir}"; then
        log_ok "Cloud driver confirmed instance exists"
        return 0
      else
        log_warn "Instance not found via cloud driver — spawn may have used a different name"
        return 0
      fi
    else
      log_err "Interactive provision failed (${harness_duration}s): ${harness_reason}"
      # Dump last 50 lines of harness log for debugging
      if [ -f "${log_file}" ]; then
        log_info "Last 50 lines of harness log:"
        tail -50 "${log_file}" | while IFS= read -r line; do
          printf '    %s\n' "${line}"
        done
      fi
      # Even on failure, try to write the .meta file so teardown can clean up
      # any VM that was partially created (e.g. on timeout mid-provision).
      cloud_provision_verify "${app_name}" "${log_dir}" 2>/dev/null || true
      return 1
    fi
  else
    log_err "Interactive harness produced no output (exit code: ${harness_exit})"
    if [ -f "${log_file}" ]; then
      log_info "Harness stderr:"
      tail -20 "${log_file}" | while IFS= read -r line; do
        printf '    %s\n' "${line}"
      done
    fi
    return 1
  fi
}
