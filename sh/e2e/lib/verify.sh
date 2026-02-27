#!/bin/bash
# e2e/lib/verify.sh — Per-agent verification (cloud-agnostic)
#
# All remote execution uses cloud_exec/cloud_exec_long from the active driver.
set -eo pipefail

# ---------------------------------------------------------------------------
# Input test constants
# ---------------------------------------------------------------------------
INPUT_TEST_PROMPT="Reply with exactly the text SPAWN_E2E_OK and nothing else."
INPUT_TEST_MARKER="SPAWN_E2E_OK"

# ---------------------------------------------------------------------------
# Per-agent input test functions
#
# Each function:
#   1. Sources env (.spawnrc, PATH)
#   2. Creates a /tmp/e2e-test git repo (agents like claude require one)
#   3. Runs the agent non-interactively with INPUT_TEST_PROMPT
#   4. Greps output for INPUT_TEST_MARKER
# ---------------------------------------------------------------------------

input_test_claude() {
  local app="$1"

  log_step "Running input test for claude..."
  # Base64-encode prompt for safe embedding.
  # -w 0 is GNU coreutils (Linux); falls back to plain base64 (macOS/BSD).
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64)
  local remote_cmd
  remote_cmd="source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(printf '%s' '${encoded_prompt}' | base64 -d); claude -p \"\$PROMPT\" 2>/dev/null"

  local output
  output=$(cloud_exec_long "${app}" "${remote_cmd}" "${INPUT_TEST_TIMEOUT}" 2>&1) || true

  if printf '%s' "${output}" | grep -q "${INPUT_TEST_MARKER}"; then
    log_ok "claude input test — marker found in response"
    return 0
  else
    log_err "claude input test — marker '${INPUT_TEST_MARKER}' not found in response"
    log_err "Response (last 5 lines):"
    printf '%s\n' "${output}" | tail -5 >&2
    return 1
  fi
}

input_test_codex() {
  local app="$1"

  log_step "Running input test for codex..."
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64)
  local remote_cmd
  remote_cmd="source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; \
    export PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(printf '%s' '${encoded_prompt}' | base64 -d); codex -q \"\$PROMPT\" 2>/dev/null"

  local output
  output=$(cloud_exec_long "${app}" "${remote_cmd}" "${INPUT_TEST_TIMEOUT}" 2>&1) || true

  if printf '%s' "${output}" | grep -q "${INPUT_TEST_MARKER}"; then
    log_ok "codex input test — marker found in response"
    return 0
  else
    log_err "codex input test — marker '${INPUT_TEST_MARKER}' not found in response"
    log_err "Response (last 5 lines):"
    printf '%s\n' "${output}" | tail -5 >&2
    return 1
  fi
}

input_test_openclaw() {
  local app="$1"

  log_step "Running input test for openclaw..."

  # Pre-check: verify the gateway is running on :18789
  log_step "Checking openclaw gateway on :18789..."
  if ! cloud_exec "${app}" "curl -sf http://localhost:18789/health >/dev/null 2>&1 || ss -tlnp | grep -q 18789" >/dev/null 2>&1; then
    log_warn "openclaw gateway not detected on :18789 — attempting test anyway"
  fi

  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64)
  local remote_cmd
  remote_cmd="source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(printf '%s' '${encoded_prompt}' | base64 -d); openclaw -p \"\$PROMPT\" 2>/dev/null"

  local output
  output=$(cloud_exec_long "${app}" "${remote_cmd}" "${INPUT_TEST_TIMEOUT}" 2>&1) || true

  if printf '%s' "${output}" | grep -q "${INPUT_TEST_MARKER}"; then
    log_ok "openclaw input test — marker found in response"
    return 0
  else
    log_err "openclaw input test — marker '${INPUT_TEST_MARKER}' not found in response"
    log_err "Response (last 5 lines):"
    printf '%s\n' "${output}" | tail -5 >&2
    return 1
  fi
}

input_test_zeroclaw() {
  local app="$1"

  log_step "Running input test for zeroclaw..."
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64)
  local remote_cmd
  remote_cmd="source ~/.spawnrc 2>/dev/null; source ~/.cargo/env 2>/dev/null; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(printf '%s' '${encoded_prompt}' | base64 -d); zeroclaw agent -p \"\$PROMPT\" 2>/dev/null"

  local output
  output=$(cloud_exec_long "${app}" "${remote_cmd}" "${INPUT_TEST_TIMEOUT}" 2>&1) || true

  if printf '%s' "${output}" | grep -q "${INPUT_TEST_MARKER}"; then
    log_ok "zeroclaw input test — marker found in response"
    return 0
  else
    log_err "zeroclaw input test — marker '${INPUT_TEST_MARKER}' not found in response"
    log_err "Response (last 5 lines):"
    printf '%s\n' "${output}" | tail -5 >&2
    return 1
  fi
}

input_test_opencode() {
  log_warn "opencode is TUI-only — skipping input test"
  return 0
}

input_test_kilocode() {
  log_warn "kilocode is TUI-only — skipping input test"
  return 0
}

# ---------------------------------------------------------------------------
# run_input_test AGENT APP_NAME
#
# Dispatch: sends a real prompt to the agent and verifies a response.
# Respects SKIP_INPUT_TEST=1 env var to bypass all input tests.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
run_input_test() {
  local agent="$1"
  local app="$2"

  if [ "${SKIP_INPUT_TEST:-0}" = "1" ]; then
    log_warn "Input test skipped (SKIP_INPUT_TEST=1)"
    return 0
  fi

  log_header "Input test: ${agent} (${app})"

  case "${agent}" in
    claude)    input_test_claude "${app}"    ;;
    codex)     input_test_codex "${app}"     ;;
    openclaw)  input_test_openclaw "${app}"  ;;
    zeroclaw)  input_test_zeroclaw "${app}"  ;;
    opencode)  input_test_opencode          ;;
    kilocode)  input_test_kilocode          ;;
    *)
      log_err "Unknown agent for input test: ${agent}"
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# verify_common APP_NAME AGENT
#
# Checks that apply to ALL agents:
#   1. Remote connectivity (SSH or CLI exec)
#   2. .spawnrc exists
#   3. .spawnrc contains OPENROUTER_API_KEY
# ---------------------------------------------------------------------------
verify_common() {
  local app="$1"
  local agent="$2"
  local failures=0

  # 1. Remote connectivity
  log_step "Checking remote connectivity..."
  if cloud_exec "${app}" "echo e2e-ssh-ok" 2>/dev/null | grep -q "e2e-ssh-ok"; then
    log_ok "Remote connectivity"
  else
    log_err "Remote connectivity failed"
    failures=$((failures + 1))
  fi

  # 2. .spawnrc exists
  log_step "Checking .spawnrc exists..."
  if cloud_exec "${app}" "test -f ~/.spawnrc" >/dev/null 2>&1; then
    log_ok ".spawnrc exists"
  else
    log_err ".spawnrc not found"
    failures=$((failures + 1))
  fi

  # 3. .spawnrc has OPENROUTER_API_KEY
  log_step "Checking OPENROUTER_API_KEY in .spawnrc..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

# ---------------------------------------------------------------------------
# Per-agent verify functions
# All checks are EXIT-CODE BASED (never capture and compare stdout).
# ---------------------------------------------------------------------------

verify_claude() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking claude binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH command -v claude" >/dev/null 2>&1; then
    log_ok "claude binary found"
  else
    log_err "claude binary not found"
    failures=$((failures + 1))
  fi

  # Config check
  log_step "Checking claude config..."
  if cloud_exec "${app}" "test -f ~/.claude/settings.json" >/dev/null 2>&1; then
    log_ok "~/.claude/settings.json exists"
  else
    log_err "~/.claude/settings.json not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking claude env (openrouter base url)..."
  if cloud_exec "${app}" "grep -q openrouter.ai ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "openrouter.ai configured in .spawnrc"
  else
    log_err "openrouter.ai not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_openclaw() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking openclaw binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH command -v openclaw" >/dev/null 2>&1; then
    log_ok "openclaw binary found"
  else
    log_err "openclaw binary not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking openclaw env (ANTHROPIC_API_KEY)..."
  if cloud_exec "${app}" "grep -q ANTHROPIC_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "ANTHROPIC_API_KEY present in .spawnrc"
  else
    log_err "ANTHROPIC_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_zeroclaw() {
  local app="$1"
  local failures=0

  # Binary check (requires cargo env)
  log_step "Checking zeroclaw binary..."
  if cloud_exec "${app}" "source ~/.cargo/env 2>/dev/null; command -v zeroclaw" >/dev/null 2>&1; then
    log_ok "zeroclaw binary found"
  else
    log_err "zeroclaw binary not found"
    failures=$((failures + 1))
  fi

  # Env check: ZEROCLAW_PROVIDER
  log_step "Checking zeroclaw env (ZEROCLAW_PROVIDER)..."
  if cloud_exec "${app}" "grep -q ZEROCLAW_PROVIDER ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "ZEROCLAW_PROVIDER present in .spawnrc"
  else
    log_err "ZEROCLAW_PROVIDER not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: provider is openrouter
  log_step "Checking zeroclaw uses openrouter..."
  if cloud_exec "${app}" "grep ZEROCLAW_PROVIDER ~/.spawnrc | grep -q openrouter" >/dev/null 2>&1; then
    log_ok "ZEROCLAW_PROVIDER set to openrouter"
  else
    log_err "ZEROCLAW_PROVIDER not set to openrouter"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_codex() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking codex binary..."
  if cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; command -v codex" >/dev/null 2>&1; then
    log_ok "codex binary found"
  else
    log_err "codex binary not found"
    failures=$((failures + 1))
  fi

  # Config check
  log_step "Checking codex config..."
  if cloud_exec "${app}" "test -f ~/.codex/config.toml" >/dev/null 2>&1; then
    log_ok "~/.codex/config.toml exists"
  else
    log_err "~/.codex/config.toml not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking codex env (OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_opencode() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking opencode binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.opencode/bin:\$PATH command -v opencode" >/dev/null 2>&1; then
    log_ok "opencode binary found"
  else
    log_err "opencode binary not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking opencode env (OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_kilocode() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking kilocode binary..."
  if cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; command -v kilocode" >/dev/null 2>&1; then
    log_ok "kilocode binary found"
  else
    log_err "kilocode binary not found"
    failures=$((failures + 1))
  fi

  # Env check: KILO_PROVIDER_TYPE
  log_step "Checking kilocode env (KILO_PROVIDER_TYPE)..."
  if cloud_exec "${app}" "grep -q KILO_PROVIDER_TYPE ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "KILO_PROVIDER_TYPE present in .spawnrc"
  else
    log_err "KILO_PROVIDER_TYPE not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: provider is openrouter
  log_step "Checking kilocode uses openrouter..."
  if cloud_exec "${app}" "grep KILO_PROVIDER_TYPE ~/.spawnrc | grep -q openrouter" >/dev/null 2>&1; then
    log_ok "KILO_PROVIDER_TYPE set to openrouter"
  else
    log_err "KILO_PROVIDER_TYPE not set to openrouter"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

# ---------------------------------------------------------------------------
# verify_agent AGENT APP_NAME
#
# Dispatch: common checks + agent-specific checks.
# Returns 0 if all pass, 1 if any fail.
# ---------------------------------------------------------------------------
verify_agent() {
  local agent="$1"
  local app="$2"
  local total_failures=0

  log_header "Verifying ${agent} (${app})"

  # Common checks
  local common_failures=0
  verify_common "${app}" "${agent}" || common_failures=$?
  total_failures=$((total_failures + common_failures))

  # Agent-specific checks
  local agent_failures=0
  case "${agent}" in
    claude)    verify_claude "${app}"    || agent_failures=$? ;;
    openclaw)  verify_openclaw "${app}"  || agent_failures=$? ;;
    zeroclaw)  verify_zeroclaw "${app}"  || agent_failures=$? ;;
    codex)     verify_codex "${app}"     || agent_failures=$? ;;
    opencode)  verify_opencode "${app}"  || agent_failures=$? ;;
    kilocode)  verify_kilocode "${app}"  || agent_failures=$? ;;
    *)
      log_err "Unknown agent: ${agent}"
      return 1
      ;;
  esac
  total_failures=$((total_failures + agent_failures))

  if [ "${total_failures}" -eq 0 ]; then
    log_ok "All checks passed for ${agent}"
    return 0
  else
    log_err "${total_failures} check(s) failed for ${agent}"
    return 1
  fi
}
