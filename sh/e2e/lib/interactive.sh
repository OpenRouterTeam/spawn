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
# _report_ux_issues RESULT_JSON AGENT CLOUD
#
# Reads uxIssues from the harness JSON result and files one GitHub issue per
# unique problem found. Skips silently if gh is unavailable or no issues found.
# ---------------------------------------------------------------------------
_report_ux_issues() {
  local result_file="$1"
  local agent="$2"
  local cloud="$3"

  if ! command -v gh >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    return 0
  fi

  local issue_count
  issue_count=$(jq -r '(.uxIssues // []) | length' "${result_file}" 2>/dev/null || printf '0')
  if [ "${issue_count}" = "0" ] || [ -z "${issue_count}" ]; then
    return 0
  fi

  log_info "UX review found ${issue_count} issue(s) — filing GitHub issue(s)..."

  # Build a single issue that lists all findings
  local title
  title="ux: spawn ${agent} ${cloud} — ${issue_count} UX issue(s) found in interactive session"

  local body
  body="$(printf '%s\n' \
    "## UX issues found during interactive E2E test" \
    "" \
    "The AI-driven interactive harness recorded a real \`spawn ${agent} ${cloud}\` session" \
    "and flagged the following UX problems in the terminal output:" \
    ""
  )"

  local i=0
  while [ "${i}" -lt "${issue_count}" ]; do
    local issue example suggestion
    issue=$(jq -r ".uxIssues[${i}].issue // \"\"" "${result_file}" 2>/dev/null || printf '')
    example=$(jq -r ".uxIssues[${i}].example // \"\"" "${result_file}" 2>/dev/null || printf '')
    suggestion=$(jq -r ".uxIssues[${i}].suggestion // \"\"" "${result_file}" 2>/dev/null || printf '')
    i=$((i + 1))
    [ -z "${issue}" ] && continue
    body="${body}
### ${i}. ${issue}

\`\`\`
${example}
\`\`\`

**Suggestion:** ${suggestion}
"
  done

  body="${body}
---
*Filed automatically by the interactive E2E harness after a live \`spawn ${agent} ${cloud}\` session.*"

  local issue_url
  if issue_url=$(gh issue create \
    --repo OpenRouterTeam/spawn \
    --title "${title}" \
    --label "ux" \
    --body "${body}" 2>/dev/null); then
    log_ok "UX issue filed: ${issue_url}"
  else
    # Label may not exist — retry without it
    if issue_url=$(gh issue create \
      --repo OpenRouterTeam/spawn \
      --title "${title}" \
      --body "${body}" 2>/dev/null); then
      log_ok "UX issue filed: ${issue_url}"
    else
      log_warn "Could not file UX issue (gh issue create failed)"
    fi
  fi
}

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
  # SPAWN_NAME bypasses the "Name your spawn" text prompt in cmdRun
  # (promptSpawnName() only checks SPAWN_NAME, not SPAWN_NAME_KEBAB)
  spawn_env="${spawn_env} SPAWN_NAME=${app_name}"
  # SPAWN_ENABLED_STEPS bypasses the setup options multiselect — accept defaults
  # so the harness tests provisioning/installation UX, not credential collection
  spawn_env="${spawn_env} SPAWN_ENABLED_STEPS=auto-update"

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

      # File GitHub issues for any UX problems found in the transcript
      _report_ux_issues "${result_file}" "${agent}" "${ACTIVE_CLOUD}"

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
