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
  # Base64-encode prompt, then pipe via stdin to avoid interpolating into the command string.
  # -w 0 is GNU coreutils (Linux); falls back to plain base64 (macOS/BSD).
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')

  local output
  output=$(printf '%s' "${encoded_prompt}" | cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(base64 -d); claude -p \"\$PROMPT\"" 2>&1) || true

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
  # Base64-encode prompt, then pipe via stdin to avoid interpolating into the command string.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')

  local output
  output=$(printf '%s' "${encoded_prompt}" | cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(base64 -d); codex exec \"\$PROMPT\"" 2>&1) || true

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

_openclaw_ensure_gateway() {
  local app="$1"
  log_step "Ensuring openclaw gateway is running on :18789..."
  # Port check: ss works on all modern Linux; /dev/tcp works on macOS/some bash.
  # Debian/Ubuntu bash is compiled WITHOUT /dev/tcp support, so ss must come first.
  local port_check='ss -tln 2>/dev/null | grep -q ":18789 " || (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null'
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    if ${port_check}; then \
      echo 'Gateway already running'; \
    else \
      _oc_bin=\$(command -v openclaw) || exit 1; \
      if command -v setsid >/dev/null 2>&1; then setsid \"\$_oc_bin\" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & \
      else nohup \"\$_oc_bin\" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi; \
      elapsed=0; _gw_up=0; while [ \$elapsed -lt 180 ]; do \
        if ${port_check}; then echo 'Gateway started'; _gw_up=1; break; fi; \
        sleep 1; elapsed=\$((elapsed + 1)); \
      done; \
      if [ \$_gw_up -eq 0 ]; then echo 'Gateway failed to start after 180s'; cat /tmp/openclaw-gateway.log 2>/dev/null; exit 1; fi; \
    fi" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    log_err "OpenClaw gateway failed to start"
    return 1
  fi
}

_openclaw_restart_gateway() {
  local app="$1"
  log_step "Restarting openclaw gateway..."
  local port_check_r='ss -tln 2>/dev/null | grep -q ":18789 " || (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null'
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    _gw_pid=\$(lsof -ti tcp:18789 2>/dev/null || fuser 18789/tcp 2>/dev/null | tr -d ' ') && \
    kill \"\$_gw_pid\" 2>/dev/null; sleep 2; \
    _oc_bin=\$(command -v openclaw) || exit 1; \
    if command -v setsid >/dev/null 2>&1; then setsid \"\$_oc_bin\" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & \
    else nohup \"\$_oc_bin\" gateway > /tmp/openclaw-gateway.log 2>&1 < /dev/null & fi; \
    elapsed=0; _gw_up=0; while [ \$elapsed -lt 180 ]; do \
      if ${port_check_r}; then echo 'Gateway restarted'; _gw_up=1; break; fi; \
      sleep 1; elapsed=\$((elapsed + 1)); \
    done; \
    if [ \$_gw_up -eq 0 ]; then echo 'Gateway restart failed after 180s'; cat /tmp/openclaw-gateway.log 2>/dev/null; exit 1; fi" >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    log_err "OpenClaw gateway failed to restart"
    return 1
  fi
}

input_test_openclaw() {
  local app="$1"
  local max_attempts=2
  local attempt=0

  log_step "Running input test for openclaw..."

  # Base64-encode prompt, then pipe via stdin to avoid interpolating into the command string.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')

  while [ "${attempt}" -lt "${max_attempts}" ]; do
    attempt=$((attempt + 1))

    # Ensure/restart gateway
    if [ "${attempt}" -eq 1 ]; then
      _openclaw_ensure_gateway "${app}"
    else
      log_warn "Retrying openclaw input test (attempt ${attempt}/${max_attempts})..."
      _openclaw_restart_gateway "${app}"
    fi

    local output
    output=$(printf '%s' "${encoded_prompt}" | cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
      export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
      rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
      PROMPT=\$(base64 -d); openclaw agent --message \"\$PROMPT\" --session-id e2e-test-${attempt} --json --timeout 60" 2>&1) || true

    if printf '%s' "${output}" | grep -q "${INPUT_TEST_MARKER}"; then
      log_ok "openclaw input test — marker found in response"
      return 0
    fi

    if [ "${attempt}" -lt "${max_attempts}" ]; then
      log_warn "openclaw input test attempt ${attempt} failed — will retry"
      log_warn "Response (last 3 lines):"
      printf '%s\n' "${output}" | tail -3 >&2
    else
      log_err "openclaw input test — marker '${INPUT_TEST_MARKER}' not found in response"
      log_err "Response (last 5 lines):"
      printf '%s\n' "${output}" | tail -5 >&2
    fi
  done

  return 1
}

input_test_zeroclaw() {
  local app="$1"

  log_step "Running input test for zeroclaw..."
  # Base64-encode prompt, then pipe via stdin to avoid interpolating into the command string.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')

  local output
  output=$(printf '%s' "${encoded_prompt}" | cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.cargo/env 2>/dev/null; \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(base64 -d); zeroclaw agent -p \"\$PROMPT\"" 2>&1) || true

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

input_test_hermes() {
  log_warn "hermes is TUI-only — skipping input test"
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
    hermes)    input_test_hermes            ;;
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
  if cloud_exec "${app}" "PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$PATH command -v claude" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH command -v openclaw" >/dev/null 2>&1; then
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

  # Gateway resilience: kill the gateway and verify it auto-restarts
  _openclaw_verify_gateway_resilience "${app}" || failures=$((failures + 1))

  return "${failures}"
}

# ---------------------------------------------------------------------------
# _openclaw_verify_gateway_resilience APP_NAME
#
# Tests that the openclaw gateway auto-restarts after being killed:
#   1. Verify gateway is running on :18789
#   2. Kill it with SIGKILL (simulates a crash)
#   3. Wait for systemd Restart=always to bring it back (~5-10s)
#   4. Verify port 18789 is listening again
# Returns 0 on success (gateway recovered), 1 on failure.
# ---------------------------------------------------------------------------
_openclaw_verify_gateway_resilience() {
  local app="$1"
  local port_check='ss -tln 2>/dev/null | grep -q ":18789 " || (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null'

  # Step 1: Confirm gateway is currently running
  log_step "Gateway resilience: checking gateway is running..."
  if ! cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    ${port_check}" >/dev/null 2>&1; then
    log_warn "Gateway not running — skipping resilience test"
    return 0
  fi
  log_ok "Gateway resilience: gateway confirmed running on :18789"

  # Step 2: Kill the gateway with SIGKILL (simulate hard crash)
  log_step "Gateway resilience: killing gateway (SIGKILL)..."
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    _gw_pid=\$(lsof -ti tcp:18789 2>/dev/null || fuser 18789/tcp 2>/dev/null | tr -d ' '); \
    if [ -n \"\$_gw_pid\" ]; then kill -9 \$_gw_pid 2>/dev/null; fi" >/dev/null 2>&1 || true

  # Brief pause to let the process die
  sleep 2

  # Confirm it's actually down
  if cloud_exec "${app}" "${port_check}" >/dev/null 2>&1; then
    log_warn "Gateway resilience: port still open after kill — process may not have died"
  else
    log_ok "Gateway resilience: gateway confirmed dead"
  fi

  # Step 3: Wait for auto-restart (systemd Restart=always, RestartSec=5)
  # Allow up to 30s for systemd to detect the crash and restart the process.
  log_step "Gateway resilience: waiting for auto-restart (up to 30s)..."
  local recovered
  recovered=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    elapsed=0; while [ \$elapsed -lt 30 ]; do \
      if ${port_check}; then echo 'recovered'; exit 0; fi; \
      sleep 1; elapsed=\$((elapsed + 1)); \
    done; echo 'timeout'" 2>&1) || true

  # Step 4: Check result
  if printf '%s' "${recovered}" | grep -q "recovered"; then
    log_ok "Gateway resilience: gateway auto-restarted successfully"
    return 0
  else
    log_err "Gateway resilience: gateway did NOT restart within 30s"
    # Dump systemd status for diagnostics
    cloud_exec "${app}" "systemctl status openclaw-gateway 2>/dev/null || true; \
      tail -10 /tmp/openclaw-gateway.log 2>/dev/null || true" 2>&1 | tail -15 >&2
    return 1
  fi
}

verify_zeroclaw() {
  local app="$1"
  local failures=0

  # Binary check (requires cargo bin in PATH — cargo/env may not exist on all clouds)
  log_step "Checking zeroclaw binary..."
  if cloud_exec "${app}" "export PATH=\$HOME/.cargo/bin:\$PATH; source ~/.cargo/env 2>/dev/null; command -v zeroclaw" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH command -v codex" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH command -v kilocode" >/dev/null 2>&1; then
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

verify_hermes() {
  local app="$1"
  local failures=0

  # Binary check
  log_step "Checking hermes binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH command -v hermes" >/dev/null 2>&1; then
    log_ok "hermes binary found"
  else
    log_err "hermes binary not found"
    failures=$((failures + 1))
  fi

  # Env check: OPENROUTER_API_KEY
  log_step "Checking hermes env (OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: OPENAI_BASE_URL points to openrouter
  log_step "Checking hermes env (OPENAI_BASE_URL)..."
  if cloud_exec "${app}" "grep OPENAI_BASE_URL ~/.spawnrc | grep -q openrouter" >/dev/null 2>&1; then
    log_ok "OPENAI_BASE_URL set to openrouter"
  else
    log_err "OPENAI_BASE_URL not set to openrouter in .spawnrc"
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
    hermes)    verify_hermes "${app}"    || agent_failures=$? ;;
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
