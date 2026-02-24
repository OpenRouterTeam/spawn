#!/bin/bash
# e2e/lib/verify.sh — SSH helpers and per-agent verification
set -eo pipefail

# ---------------------------------------------------------------------------
# Machine ID cache (avoid repeated API calls)
# ---------------------------------------------------------------------------
_FLY_MACHINE_ID=""
_FLY_MACHINE_APP=""

# ---------------------------------------------------------------------------
# fly_ssh APP_NAME COMMAND
#
# Resolves machine ID, escapes single quotes, and runs the command via
# flyctl machine exec. Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
fly_ssh() {
  local app="$1"
  local cmd="$2"

  # Resolve machine ID (cached per app)
  if [ "${_FLY_MACHINE_APP}" != "${app}" ] || [ -z "${_FLY_MACHINE_ID}" ]; then
    _FLY_MACHINE_ID=$(flyctl machines list -a "${app}" --json 2>/dev/null | jq -r '.[0].id')
    _FLY_MACHINE_APP="${app}"
    if [ -z "${_FLY_MACHINE_ID}" ] || [ "${_FLY_MACHINE_ID}" = "null" ]; then
      log_err "Could not resolve machine ID for app ${app}"
      return 1
    fi
  fi

  # Escape single quotes in command: each ' becomes '\''
  local escaped_cmd
  escaped_cmd=$(printf '%s' "${cmd}" | sed "s/'/'\\\\''/g")

  flyctl machine exec "${_FLY_MACHINE_ID}" -a "${app}" --timeout 30 "bash -c '${escaped_cmd}'"
}

# ---------------------------------------------------------------------------
# verify_common APP_NAME AGENT
#
# Checks that apply to ALL agents:
#   1. SSH connectivity
#   2. .spawnrc exists
#   3. .spawnrc contains OPENROUTER_API_KEY
# ---------------------------------------------------------------------------
verify_common() {
  local app="$1"
  local agent="$2"
  local failures=0

  # 1. SSH connectivity
  log_step "Checking SSH connectivity..."
  if fly_ssh "${app}" "echo e2e-ssh-ok" 2>/dev/null | grep -q "e2e-ssh-ok"; then
    log_ok "SSH connectivity"
  else
    log_err "SSH connectivity failed"
    failures=$((failures + 1))
  fi

  # 2. .spawnrc exists
  log_step "Checking .spawnrc exists..."
  if fly_ssh "${app}" "test -f ~/.spawnrc" >/dev/null 2>&1; then
    log_ok ".spawnrc exists"
  else
    log_err ".spawnrc not found"
    failures=$((failures + 1))
  fi

  # 3. .spawnrc has OPENROUTER_API_KEY
  log_step "Checking OPENROUTER_API_KEY in .spawnrc..."
  if fly_ssh "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "PATH=\$HOME/.claude/local/bin:\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH command -v claude" >/dev/null 2>&1; then
    log_ok "claude binary found"
  else
    log_err "claude binary not found"
    failures=$((failures + 1))
  fi

  # Config check
  log_step "Checking claude config..."
  if fly_ssh "${app}" "test -f ~/.claude/settings.json" >/dev/null 2>&1; then
    log_ok "~/.claude/settings.json exists"
  else
    log_err "~/.claude/settings.json not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking claude env (openrouter base url)..."
  if fly_ssh "${app}" "grep -q openrouter.ai ~/.spawnrc" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH command -v openclaw" >/dev/null 2>&1; then
    log_ok "openclaw binary found"
  else
    log_err "openclaw binary not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking openclaw env (ANTHROPIC_API_KEY)..."
  if fly_ssh "${app}" "grep -q ANTHROPIC_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "source ~/.cargo/env 2>/dev/null; command -v zeroclaw" >/dev/null 2>&1; then
    log_ok "zeroclaw binary found"
  else
    log_err "zeroclaw binary not found"
    failures=$((failures + 1))
  fi

  # Env check: ZEROCLAW_PROVIDER
  log_step "Checking zeroclaw env (ZEROCLAW_PROVIDER)..."
  if fly_ssh "${app}" "grep -q ZEROCLAW_PROVIDER ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "ZEROCLAW_PROVIDER present in .spawnrc"
  else
    log_err "ZEROCLAW_PROVIDER not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: provider is openrouter
  log_step "Checking zeroclaw uses openrouter..."
  if fly_ssh "${app}" "grep ZEROCLAW_PROVIDER ~/.spawnrc | grep -q openrouter" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; command -v codex" >/dev/null 2>&1; then
    log_ok "codex binary found"
  else
    log_err "codex binary not found"
    failures=$((failures + 1))
  fi

  # Config check
  log_step "Checking codex config..."
  if fly_ssh "${app}" "test -f ~/.codex/config.toml" >/dev/null 2>&1; then
    log_ok "~/.codex/config.toml exists"
  else
    log_err "~/.codex/config.toml not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking codex env (OPENROUTER_API_KEY)..."
  if fly_ssh "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "PATH=\$HOME/.opencode/bin:\$PATH command -v opencode" >/dev/null 2>&1; then
    log_ok "opencode binary found"
  else
    log_err "opencode binary not found"
    failures=$((failures + 1))
  fi

  # Env check
  log_step "Checking opencode env (OPENROUTER_API_KEY)..."
  if fly_ssh "${app}" "grep -q OPENROUTER_API_KEY ~/.spawnrc" >/dev/null 2>&1; then
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
  if fly_ssh "${app}" "source ~/.spawnrc 2>/dev/null; source ~/.zshrc 2>/dev/null; command -v kilocode" >/dev/null 2>&1; then
    log_ok "kilocode binary found"
  else
    log_err "kilocode binary not found"
    failures=$((failures + 1))
  fi

  # Env check: KILO_PROVIDER_TYPE
  log_step "Checking kilocode env (KILO_PROVIDER_TYPE)..."
  if fly_ssh "${app}" "grep -q KILO_PROVIDER_TYPE ~/.spawnrc" >/dev/null 2>&1; then
    log_ok "KILO_PROVIDER_TYPE present in .spawnrc"
  else
    log_err "KILO_PROVIDER_TYPE not found in .spawnrc"
    failures=$((failures + 1))
  fi

  # Env check: provider is openrouter
  log_step "Checking kilocode uses openrouter..."
  if fly_ssh "${app}" "grep KILO_PROVIDER_TYPE ~/.spawnrc | grep -q openrouter" >/dev/null 2>&1; then
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

  # Reset machine ID cache for each agent
  _FLY_MACHINE_ID=""
  _FLY_MACHINE_APP=""

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
