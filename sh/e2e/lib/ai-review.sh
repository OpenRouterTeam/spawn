#!/bin/bash
# e2e/lib/ai-review.sh — AI-powered log analysis for E2E test output
#
# After provision + verify pass, feeds stderr/stdout logs to an LLM to catch
# non-fatal issues that binary pass/fail checks miss: silent 404s, degraded
# installs, swallowed warnings, connection instability, etc.
#
# Diff-aware: includes the git diff since the last successful E2E run so the
# AI can do causal analysis ("this 404 started after commit X which removed Y").
#
# Requires: OPENROUTER_API_KEY (reuses the same key used for E2E provisioning)
# Skips gracefully if the key is missing or the API call fails.
set -eo pipefail

# ---------------------------------------------------------------------------
# _get_diff_since_last_green
#
# Returns the git diff (stat + patch, truncated) since the e2e-last-green tag.
# If the tag doesn't exist, returns empty string.
# ---------------------------------------------------------------------------
_get_diff_since_last_green() {
  if ! git rev-parse "e2e-last-green" >/dev/null 2>&1; then
    return 0
  fi
  local diff
  diff=$(git diff "e2e-last-green"..HEAD --stat --patch -- 'packages/cli/src/**' 'sh/**' 'packer/**' 'manifest.json' 2>/dev/null | head -300 || true)
  printf '%s' "${diff}"
}

# ---------------------------------------------------------------------------
# mark_e2e_green
#
# Advances the e2e-last-green tag to HEAD after a fully passing E2E run.
# ---------------------------------------------------------------------------
mark_e2e_green() {
  git tag -f "e2e-last-green" HEAD >/dev/null 2>&1 || true
  git push origin "e2e-last-green" --force >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# ai_review_logs AGENT APP_NAME LOG_DIR
#
# Analyzes provision logs for an agent and reports findings as warnings.
# Returns 0 always (advisory only — never fails the test).
# ---------------------------------------------------------------------------
ai_review_logs() {
  local agent="$1"
  local app_name="$2"
  local log_dir="$3"

  local api_key="${OPENROUTER_API_KEY:-}"
  if [ -z "${api_key}" ]; then
    return 0
  fi

  local stdout_file="${log_dir}/${app_name}.stdout"
  local stderr_file="${log_dir}/${app_name}.stderr"

  # Collect log content (truncate to last 200 lines each to stay within token limits)
  local log_content=""
  if [ -f "${stderr_file}" ] && [ -s "${stderr_file}" ]; then
    log_content="=== STDERR (last 200 lines) ===
$(tail -200 "${stderr_file}" 2>/dev/null || true)
"
  fi
  if [ -f "${stdout_file}" ] && [ -s "${stdout_file}" ]; then
    log_content="${log_content}=== STDOUT (last 200 lines) ===
$(tail -200 "${stdout_file}" 2>/dev/null || true)
"
  fi

  # Skip if no log content
  if [ -z "${log_content}" ]; then
    return 0
  fi

  # Get diff context for causal analysis
  local diff_context
  diff_context=$(_get_diff_since_last_green 2>/dev/null || true)

  log_step "AI reviewing ${agent} logs..."

  # Build the prompt
  local system_prompt='You are a QA engineer reviewing deployment logs from an automated E2E test of "spawn" — a tool that provisions cloud VMs and installs AI coding agents.

Your job: find issues that passed the binary tests but indicate degraded or broken behavior. Focus on:
- HTTP errors (404, 500, timeouts) even if the step was marked non-fatal
- Failed installations of components (keep-alive scripts, browser, plugins)
- Connection drops, retries, or timeouts during provisioning
- Warnings that indicate missing functionality
- Security warnings (exposed credentials, insecure connections)
- Package deprecation warnings that could break future builds

You are also given the git diff since the last successful E2E run. Use this for CAUSAL ANALYSIS:
- If you see an error, check if a recent commit could have caused it (file moved/deleted, URL changed, config altered)
- Correlate log errors with specific commits when possible
- Flag if a changed file is referenced by a URL or path that now 404s

Do NOT flag:
- Normal npm deprecation warnings for transient dependencies (these are upstream)
- Successful retries (only flag if all retries failed)
- Expected "non-interactive" or "headless" mode messages
- Informational step progress messages

Output format: If you find issues, output one line per issue:
ISSUE: <severity:low|medium|high> <brief description>

If a commit likely caused the issue, append: (likely caused by <short-hash> <first line of commit msg>)

If no issues found, output exactly: NO_ISSUES

Be concise. Max 5 issues.'

  # Use a temp file for the request body to avoid shell quoting issues
  local req_file
  req_file=$(mktemp /tmp/e2e-ai-review-XXXXXX.json)

  # Build JSON safely via bun to avoid shell injection
  local ts_file
  ts_file=$(mktemp /tmp/e2e-ai-build-XXXXXX.ts)
  cat > "${ts_file}" << 'TS_EOF'
const system = process.env._AI_SYSTEM ?? "";
const logs = process.env._AI_LOGS ?? "";
const diff = process.env._AI_DIFF ?? "";
const agent = process.env._AI_AGENT ?? "";
const outFile = process.env._AI_OUT ?? "";

let userContent = `Agent: ${agent}\n\nDeployment logs:\n\n${logs}`;
if (diff) {
  userContent += `\n\nGit changes since last green run:\n\n${diff}`;
}

const body = {
  model: "google/gemini-flash-lite-2.0",
  max_tokens: 512,
  messages: [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ],
};

await Bun.write(outFile, JSON.stringify(body));
TS_EOF

  _AI_SYSTEM="${system_prompt}" \
  _AI_LOGS="${log_content}" \
  _AI_DIFF="${diff_context}" \
  _AI_AGENT="${agent}" \
  _AI_OUT="${req_file}" \
    bun run "${ts_file}" 2>/dev/null

  rm -f "${ts_file}" 2>/dev/null || true

  # Call OpenRouter API
  local response
  response=$(curl -sf --max-time 30 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${api_key}" \
    -d @"${req_file}" \
    "https://openrouter.ai/api/v1/chat/completions" 2>/dev/null) || {
    rm -f "${req_file}" 2>/dev/null || true
    log_warn "AI review skipped (API call failed)"
    return 0
  }

  rm -f "${req_file}" 2>/dev/null || true

  # Extract the response content
  local ai_output
  ai_output=$(printf '%s' "${response}" | bun -e "
    const data = JSON.parse(await Bun.stdin.text());
    const content = data?.choices?.[0]?.message?.content ?? '';
    process.stdout.write(content);
  " 2>/dev/null) || {
    log_warn "AI review skipped (failed to parse response)"
    return 0
  }

  # Parse and report findings
  if printf '%s' "${ai_output}" | grep -q "NO_ISSUES"; then
    log_ok "AI review: no issues found"
    return 0
  fi

  # Report each issue as a warning
  local issue_count=0
  while IFS= read -r line; do
    case "${line}" in
      ISSUE:*)
        issue_count=$((issue_count + 1))
        log_warn "AI review: ${line#ISSUE: }"
        ;;
    esac
  done <<< "${ai_output}"

  if [ "${issue_count}" -eq 0 ]; then
    log_ok "AI review: no issues found"
  else
    log_warn "AI review: ${issue_count} issue(s) found for ${agent}"
  fi

  return 0
}
