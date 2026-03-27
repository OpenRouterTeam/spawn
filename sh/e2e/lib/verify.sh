#!/bin/bash
# e2e/lib/verify.sh — Per-agent verification (cloud-agnostic)
#
# All remote execution uses cloud_exec from the active driver.
set -eo pipefail

# ---------------------------------------------------------------------------
# Input test constants
# ---------------------------------------------------------------------------
INPUT_TEST_PROMPT="Reply with exactly the text SPAWN_E2E_OK and nothing else."
INPUT_TEST_MARKER="SPAWN_E2E_OK"

# ---------------------------------------------------------------------------
# _validate_timeout
#
# Defense-in-depth: ensures INPUT_TEST_TIMEOUT contains only digits before it
# is interpolated into any remote command string. This prevents command
# injection even if common.sh's validation is bypassed or the variable is
# modified after sourcing.
# ---------------------------------------------------------------------------
_validate_timeout() {
  case "${INPUT_TEST_TIMEOUT:-}" in
    ''|*[!0-9]*)
      log_err "SECURITY: INPUT_TEST_TIMEOUT contains non-numeric characters — aborting"
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# _validate_base64 VALUE
#
# Validates that VALUE contains only base64-safe characters ([A-Za-z0-9+/=]).
# Dies with an error if the check fails. Defense-in-depth: even though the
# prompt is written to a remote temp file (not interpolated into a command
# string), we still validate as a safety net.
# ---------------------------------------------------------------------------
_validate_base64() {
  local val="$1"
  # Use printf + grep to avoid bash regex portability issues (bash 3.x on macOS)
  if [ -z "${val}" ] || ! printf '%s' "${val}" | grep -qE '^[A-Za-z0-9+/=]*$'; then
    log_err "SECURITY: encoded_prompt contains non-base64 characters — aborting"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# _stage_prompt_remotely APP ENCODED_PROMPT
#
# Writes the base64-encoded prompt to a temp file on the remote host.
# The encoded_prompt is validated by _validate_base64 to contain only
# [A-Za-z0-9+/=] characters. The value is assigned to a shell variable
# on the remote side and re-validated there before writing to the file,
# providing defense-in-depth against injection even if local validation
# is bypassed.
# ---------------------------------------------------------------------------
_stage_prompt_remotely() {
  local app="$1"
  local encoded_prompt="$2"
  # Assign the validated base64 value to a remote variable, re-validate it
  # on the remote side (defense-in-depth), then write to the temp file.
  # Base64 chars [A-Za-z0-9+/=] cannot break out of single quotes.
  cloud_exec "${app}" "_EP='${encoded_prompt}'; printf '%s' \"\$_EP\" | grep -qE '^[A-Za-z0-9+/=]*$' && printf '%s' \"\$_EP\" > /tmp/.e2e-prompt || exit 1"
}

# ---------------------------------------------------------------------------
# _stage_timeout_remotely APP TIMEOUT
#
# Writes the validated timeout value to a temp file on the remote host.
# The value is assigned to a shell variable on the remote side and
# re-validated there before writing to the file, providing defense-in-depth
# against injection even if local validation is bypassed.
# ---------------------------------------------------------------------------
_stage_timeout_remotely() {
  local app="$1"
  local timeout_val="$2"
  # Assign the validated digits-only value to a remote variable, re-validate
  # it on the remote side (defense-in-depth), then write to the temp file.
  # Digits [0-9] cannot break out of single quotes or inject shell metacharacters.
  cloud_exec "${app}" "_TV='${timeout_val}'; printf '%s' \"\$_TV\" | grep -qE '^[0-9]+$' && printf '%s' \"\$_TV\" > /tmp/.e2e-timeout || exit 1"
}

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

  _validate_timeout || return 1

  log_step "Running input test for claude..."
  # Base64-encode the prompt and stage it to a remote temp file.
  # This avoids interpolating prompt data into the agent command string.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')
  _validate_base64 "${encoded_prompt}" || return 1
  _stage_prompt_remotely "${app}" "${encoded_prompt}"
  _stage_timeout_remotely "${app}" "${INPUT_TEST_TIMEOUT}"

  local output
  # claude -p (--print) reads the prompt from stdin.
  # --dangerously-skip-permissions: bypass trust dialog for /tmp/e2e-test
  #   (newer Claude Code requires per-directory trust; /tmp/e2e-test is not
  #   in the ~/.claude.json trusted projects list written during install)
  # --no-session-persistence: don't write session files to disk during tests
  # The prompt and timeout are read from staged temp files — no interpolation in this command.
  output=$(cloud_exec "${app}" "\
    source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    _TIMEOUT=\$(cat /tmp/.e2e-timeout); \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(cat /tmp/.e2e-prompt | base64 -d); \
    timeout \"\$_TIMEOUT\" claude -p --dangerously-skip-permissions --no-session-persistence \"\$PROMPT\"" 2>&1) || true

  if printf '%s' "${output}" | grep -qx "${INPUT_TEST_MARKER}"; then
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

  _validate_timeout || return 1

  log_step "Running input test for codex..."
  # Base64-encode the prompt and stage it to a remote temp file.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')
  _validate_base64 "${encoded_prompt}" || return 1
  _stage_prompt_remotely "${app}" "${encoded_prompt}"
  _stage_timeout_remotely "${app}" "${INPUT_TEST_TIMEOUT}"

  local output
  # codex exec --full-auto: non-interactive subcommand for v0.116.0+
  # The prompt and timeout are read from staged temp files — no interpolation in this command.
  output=$(cloud_exec "${app}" "\
    source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH; \
    _TIMEOUT=\$(cat /tmp/.e2e-timeout); \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(cat /tmp/.e2e-prompt | base64 -d); \
    timeout \"\$_TIMEOUT\" codex exec --full-auto \"\$PROMPT\"" 2>&1) || true

  if printf '%s' "${output}" | grep -qx "${INPUT_TEST_MARKER}"; then
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
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.bashrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
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
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.bashrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
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

  _validate_timeout || return 1

  log_step "Running input test for openclaw..."

  # Base64-encode the prompt and stage it to a remote temp file.
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')
  _validate_base64 "${encoded_prompt}" || return 1
  _stage_prompt_remotely "${app}" "${encoded_prompt}"
  _stage_timeout_remotely "${app}" "${INPUT_TEST_TIMEOUT}"

  while [ "${attempt}" -lt "${max_attempts}" ]; do
    attempt=$((attempt + 1))

    # Ensure/restart gateway
    if [ "${attempt}" -eq 1 ]; then
      _openclaw_ensure_gateway "${app}"
    else
      log_warn "Retrying openclaw input test (attempt ${attempt}/${max_attempts})..."
      _openclaw_restart_gateway "${app}"
    fi

    # Stage the attempt number to a remote temp file for safe use in --session-id
    printf '%s' "${attempt}" | cloud_exec "${app}" "cat > /tmp/.e2e-attempt"

    local output
    # The prompt, timeout, and attempt are read from staged temp files — no interpolation in this command.
    output=$(cloud_exec "${app}" "\
      source ~/.spawnrc 2>/dev/null; source ~/.bashrc 2>/dev/null; \
      export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
      _TIMEOUT=\$(cat /tmp/.e2e-timeout); \
      _ATTEMPT=\$(cat /tmp/.e2e-attempt); \
      rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
      PROMPT=\$(cat /tmp/.e2e-prompt | base64 -d); \
      timeout \"\$_TIMEOUT\" openclaw agent --message \"\$PROMPT\" --session-id \"e2e-test-\$_ATTEMPT\" --json --timeout 60" 2>&1) || true

    if printf '%s' "${output}" | grep -qx "${INPUT_TEST_MARKER}"; then
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

  _validate_timeout || return 1

  log_step "Running input test for zeroclaw..."
  # Base64-encode the prompt and stage it to a remote temp file.
  # Use -m/--message for non-interactive single-message mode (not -p which is --provider).
  local encoded_prompt
  encoded_prompt=$(printf '%s' "${INPUT_TEST_PROMPT}" | base64 -w 0 2>/dev/null || printf '%s' "${INPUT_TEST_PROMPT}" | base64 | tr -d '\n')
  _validate_base64 "${encoded_prompt}" || return 1
  _stage_prompt_remotely "${app}" "${encoded_prompt}"
  _stage_timeout_remotely "${app}" "${INPUT_TEST_TIMEOUT}"

  local output
  # The prompt and timeout are read from staged temp files — no interpolation in this command.
  output=$(cloud_exec "${app}" "\
    source ~/.spawnrc 2>/dev/null; source ~/.cargo/env 2>/dev/null; \
    _TIMEOUT=\$(cat /tmp/.e2e-timeout); \
    rm -rf /tmp/e2e-test && mkdir -p /tmp/e2e-test && cd /tmp/e2e-test && git init -q; \
    PROMPT=\$(cat /tmp/.e2e-prompt | base64 -d); \
    timeout \"\$_TIMEOUT\" zeroclaw agent -m \"\$PROMPT\"" 2>&1) || true

  if printf '%s' "${output}" | grep -qx "${INPUT_TEST_MARKER}"; then
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

input_test_junie() {
  log_warn "junie CLI input test not yet implemented — skipping"
  return 0
}

input_test_cursor() {
  log_warn "cursor is TUI-only — skipping input test"
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
    junie)     input_test_junie            ;;
    cursor)    input_test_cursor           ;;
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

  # Binary check — source .spawnrc and .bashrc to pick up all PATH entries.
  # On Sprite VMs, npm's global prefix may be the nvm node bin dir (writable +
  # in PATH after .bashrc), so openclaw lands there instead of ~/.npm-global/bin.
  # On GCP VMs (root user), npm installs to /usr/local/bin directly (no --prefix).
  # Include /usr/local/bin explicitly so the check doesn't rely solely on .spawnrc.
  log_step "Checking openclaw binary..."
  if cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.bashrc 2>/dev/null; export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; command -v openclaw" >/dev/null 2>&1; then
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
#   3. Wait for systemd Restart=always to bring it back (up to 60s)
#   4. Verify port 18789 is listening again
# Note: slow VMs (GCP e2-micro) may need 2 restart cycles due to openclaw's
# lock file not releasing until ~5s after kill, causing the first restart to
# fail with "lock timeout". The 60s window covers 2 full restart cycles.
# Returns 0 on success (gateway recovered), 1 on failure.
# ---------------------------------------------------------------------------
_openclaw_verify_gateway_resilience() {
  local app="$1"
  local port_check='ss -tln 2>/dev/null | grep -q ":18789 " || (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null'

  # Step 1: Confirm gateway is currently running
  log_step "Gateway resilience: checking gateway is running..."
  if ! cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
    ${port_check}" >/dev/null 2>&1; then
    log_warn "Gateway not running — skipping resilience test"
    return 0
  fi
  log_ok "Gateway resilience: gateway confirmed running on :18789"

  # Step 2: Kill the gateway with SIGKILL (simulate hard crash)
  log_step "Gateway resilience: killing gateway (SIGKILL)..."
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
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
  # Allow up to 60s: on slow VMs (e.g. GCP e2-micro), the openclaw lock file
  # may not release until after the first restart attempt fails (~5s lock
  # timeout), requiring a second restart cycle before the gateway is up.
  # Timeline: RestartSec(5) + lock-timeout(5) + RestartSec(5) + boot(5) ≈ 20s.
  # 60s gives a comfortable margin for slow/throttled VMs.
  log_step "Gateway resilience: waiting for auto-restart (up to 60s)..."
  local recovered
  recovered=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH; \
    elapsed=0; while [ \$elapsed -lt 60 ]; do \
      if ${port_check}; then echo 'recovered'; exit 0; fi; \
      sleep 1; elapsed=\$((elapsed + 1)); \
    done; echo 'timeout'" 2>&1) || true

  # Step 4: Check result
  if printf '%s' "${recovered}" | grep -q "recovered"; then
    log_ok "Gateway resilience: gateway auto-restarted successfully"
    return 0
  else
    log_err "Gateway resilience: gateway did NOT restart within 60s"
    # Dump systemd status for diagnostics
    cloud_exec "${app}" "systemctl status openclaw-gateway 2>/dev/null || true; \
      tail -10 /tmp/openclaw-gateway.log 2>/dev/null || true" 2>&1 | tail -15 >&2
    return 1
  fi
}

verify_zeroclaw() {
  local app="$1"
  local failures=0

  # Binary check (may be in ~/.local/bin or ~/.cargo/bin depending on install method)
  log_step "Checking zeroclaw binary..."
  if cloud_exec "${app}" "export PATH=\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH; source ~/.cargo/env 2>/dev/null; command -v zeroclaw" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH command -v codex" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH command -v kilocode" >/dev/null 2>&1; then
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
  if cloud_exec "${app}" "PATH=\$HOME/.local/bin:\$HOME/.hermes/hermes-agent/venv/bin:\$HOME/.bun/bin:\$PATH command -v hermes" >/dev/null 2>&1; then
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

verify_junie() {
  local app="$1"
  local failures=0

  # Binary check — @jetbrains/junie-cli postinstall may place the binary in
  # non-standard locations (e.g. ~/.junie/bin/, npm global root, /usr/local/bin)
  log_step "Checking junie binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.npm-global/bin:\$HOME/.junie/bin:\$HOME/.bun/bin:\$HOME/.local/bin:/usr/local/bin:\$(npm bin -g 2>/dev/null || echo /dev/null):\$PATH command -v junie" >/dev/null 2>&1; then
    log_ok "junie binary found"
  else
    log_err "junie binary not found"
    failures=$((failures + 1))
  fi

  # Env check: JUNIE_OPENROUTER_API_KEY
  log_step "Checking junie env (JUNIE_OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q JUNIE_OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "JUNIE_OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "JUNIE_OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: OPENROUTER_API_KEY
  log_step "Checking junie env (OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  return "${failures}"
}

verify_cursor() {
  local app="$1"
  local failures=0

  # Binary check — cursor installs to ~/.local/bin/agent (since 2026-03-25)
  log_step "Checking cursor binary..."
  if cloud_exec "${app}" "PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH command -v agent" >/dev/null 2>&1; then
    log_ok "cursor (agent) binary found"
  else
    log_err "cursor (agent) binary not found"
    failures=$((failures + 1))
  fi

  # Env check: CURSOR_API_KEY
  log_step "Checking cursor env (CURSOR_API_KEY)..."
  if cloud_exec "${app}" "grep -q CURSOR_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "CURSOR_API_KEY present in .spawnrc"
  else
    log_err "CURSOR_API_KEY not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: OPENROUTER_API_KEY
  log_step "Checking cursor env (OPENROUTER_API_KEY)..."
  if cloud_exec "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "OPENROUTER_API_KEY present in .spawnrc"
  else
    log_err "OPENROUTER_API_KEY not found in .spawnrc"
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
    junie)     verify_junie "${app}"    || agent_failures=$? ;;
    cursor)    verify_cursor "${app}"   || agent_failures=$? ;;
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
