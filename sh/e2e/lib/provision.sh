#!/bin/bash
# e2e/lib/provision.sh — Provision an agent VM via spawn CLI (cloud-agnostic)
set -eo pipefail

# ---------------------------------------------------------------------------
# provision_agent AGENT APP_NAME LOG_DIR
#
# Runs spawn in headless mode with a timeout. The provision process hangs on
# the interactive SSH session (step 12 of the orchestration), so we kill it
# after PROVISION_TIMEOUT seconds. The install itself usually succeeds; we
# verify via instance existence and .spawnrc presence afterward.
#
# Uses cloud driver functions:
#   cloud_headless_env  — cloud-specific env var exports
#   cloud_provision_verify — check instance exists, write IP + metadata
#   cloud_exec          — remote command execution
# ---------------------------------------------------------------------------
provision_agent() {
  local agent="$1"
  local app_name="$2"
  local log_dir="$3"

  local exit_file="${log_dir}/${app_name}.exit"
  local stdout_file="${log_dir}/${app_name}.stdout"
  local stderr_file="${log_dir}/${app_name}.stderr"

  # Resolve CLI entry point
  # SPAWN_CLI_DIR overrides auto-resolution — use this to force local source code
  local cli_entry
  if [ -n "${SPAWN_CLI_DIR:-}" ]; then
    cli_entry="${SPAWN_CLI_DIR}/packages/cli/src/index.ts"
  else
    cli_entry="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/packages/cli/src/index.ts"
  fi

  if [ ! -f "${cli_entry}" ]; then
    log_err "CLI entry point not found: ${cli_entry}"
    return 1
  fi

  log_step "Provisioning ${agent} as ${app_name} on ${ACTIVE_CLOUD} (timeout: ${PROVISION_TIMEOUT}s)"

  # Remove stale exit file
  rm -f "${exit_file}"

  # Environment for headless provisioning
  # MODEL_ID bypasses the interactive model selection prompt (required by openclaw)
  (
    export SPAWN_NON_INTERACTIVE=1
    export SPAWN_SKIP_GITHUB_AUTH=1
    export SPAWN_SKIP_API_VALIDATION=1
    export SPAWN_NO_UPDATE_CHECK=1
    export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
    export SPAWN_CLI_DIR="${SPAWN_CLI_DIR:-}"
    export MODEL_ID="${MODEL_ID:-openrouter/auto}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY}"

    # Apply cloud-specific env vars (safe: only processes export VAR="VALUE" lines)
    # Uses sed instead of BASH_REMATCH for macOS bash 3.2 compatibility
    while IFS= read -r _env_line; do
      # Skip lines that don't look like export VAR="VALUE"
      case "${_env_line}" in
        export\ *=*) ;;
        *) continue ;;
      esac
      # Extract variable name and value using sed
      _env_name=$(printf '%s' "${_env_line}" | sed -n 's/^export  *\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\1/p')
      _env_val=$(printf '%s' "${_env_line}" | sed -n 's/^export  *\([A-Za-z_][A-Za-z0-9_]*\)="\(.*\)"$/\2/p')
      if [ -z "${_env_name}" ]; then
        continue
      fi
      # Block dangerous system env vars that could enable privilege escalation
      case "${_env_name}" in
        PATH|LD_PRELOAD|LD_LIBRARY_PATH|HOME|SHELL|USER|IFS|ENV|BASH_ENV|CDPATH)
          log_err "Blocked dangerous env var: ${_env_name}"
          continue
          ;;
      esac
      # Validate env var name matches strict alphanumeric pattern
      if ! printf '%s' "${_env_name}" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
        log_err "Invalid env var name: ${_env_name}"
        continue
      fi
      # Validate value against a safe character whitelist BEFORE export
      if printf '%s' "${_env_val}" | grep -qE '[^A-Za-z0-9@%+=:,./_-]'; then
        log_err "Invalid characters in env value for ${_env_name}"
        continue
      fi
      export "${_env_name}=${_env_val}"
    done <<CLOUD_ENV
$(cloud_headless_env "${app_name}" "${agent}")
CLOUD_ENV

    bun run "${cli_entry}" "${agent}" "${ACTIVE_CLOUD}" --headless --output json \
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

  # Kill if still running (the interactive SSH/CLI session hangs)
  if [ ! -f "${exit_file}" ]; then
    log_warn "Provision timed out after ${PROVISION_TIMEOUT}s — killing (install may still succeed)"
    # Kill the entire process tree — the subshell spawns bun → sprite exec -tty
    # which won't die from just killing the subshell PID. Without this, orphaned
    # sprite exec sessions keep running and corrupt the sprite config file.
    pkill -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
    # Also kill any lingering sprite exec processes for this specific app.
    # Validate app_name is non-empty and contains only safe characters to
    # prevent overly broad pkill -f patterns from killing unrelated processes.
    if [ -n "${app_name}" ] && printf '%s' "${app_name}" | grep -qE '^[A-Za-z0-9._-]+$'; then
      # Escape regex metacharacters in app_name before using in pkill -f
      # pattern to prevent unintended process termination (#2409)
      local escaped_name
      escaped_name=$(printf '%s' "${app_name}" | sed 's/[.[\*^$]/\\&/g')
      pkill -f "sprite exec.*${escaped_name}" 2>/dev/null || true
    fi
    sleep 1
  fi

  # Even if provision "failed" (timeout), the instance may exist and install may have completed.
  # Verify instance existence via cloud driver.
  if ! cloud_provision_verify "${app_name}" "${log_dir}"; then
    log_err "Instance ${app_name} does not exist after provisioning"
    if [ -f "${stderr_file}" ]; then
      log_err "Stderr tail:"
      tail -20 "${stderr_file}" >&2 || true
    fi
    return 1
  fi

  log_ok "Instance ${app_name} verified"

  # Wait for install to complete (.spawnrc is written near the end)
  local effective_install_wait
  effective_install_wait=$(cloud_install_wait)
  log_step "Waiting for install to complete (polling .spawnrc, up to ${effective_install_wait}s)..."
  local install_waited=0
  local install_ok=0
  while [ "${install_waited}" -lt "${effective_install_wait}" ]; do
    if cloud_exec "${app_name}" "test -f ~/.spawnrc" >/dev/null 2>&1; then
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
  fi

  # Fallback: CLI was killed before writing .spawnrc (provision timeout race).
  # Construct .spawnrc manually via SSH using available env vars.
  log_warn ".spawnrc not found after ${effective_install_wait}s — attempting manual creation"
  local api_key="${OPENROUTER_API_KEY:-}"
  if [ -z "${api_key}" ]; then
    log_err "Cannot create .spawnrc fallback — OPENROUTER_API_KEY not set"
    return 0
  fi

  # Build env lines in a temp file to avoid interpolating api_key into shell
  # strings directly (prevents command injection if the key contains shell
  # metacharacters like single quotes, backticks, or dollar signs).
  local env_tmp
  env_tmp=$(mktemp)
  {
    printf '%s\n' "# [spawn:env]"
    printf 'export IS_SANDBOX=%q\n' "1"
    printf 'export OPENROUTER_API_KEY=%q\n' "${api_key}"
  } > "${env_tmp}"

  # Add agent-specific env vars
  case "${agent}" in
    openclaw)
      {
        printf 'export ANTHROPIC_API_KEY=%q\n' "${api_key}"
        printf 'export ANTHROPIC_BASE_URL=%q\n' "https://openrouter.ai/api"
      } >> "${env_tmp}"
      ;;
    zeroclaw)
      {
        printf 'export ZEROCLAW_PROVIDER=%q\n' "openrouter"
      } >> "${env_tmp}"
      ;;
    hermes)
      {
        printf 'export OPENAI_BASE_URL=%q\n' "https://openrouter.ai/api/v1"
        printf 'export OPENAI_API_KEY=%q\n' "${api_key}"
      } >> "${env_tmp}"
      ;;
    kilocode)
      {
        printf 'export KILO_PROVIDER_TYPE=%q\n' "openrouter"
        printf 'export KILO_OPEN_ROUTER_API_KEY=%q\n' "${api_key}"
      } >> "${env_tmp}"
      ;;
    junie)
      {
        printf 'export JUNIE_OPENROUTER_API_KEY=%q\n' "${api_key}"
      } >> "${env_tmp}"
      ;;
  esac

  # Base64-encode credentials, validate the output, then pipe to cloud_exec.
  local env_b64
  env_b64=$(base64 < "${env_tmp}" | tr -d '\n')

  # Validate base64 output contains only safe characters (defense-in-depth)
  if ! printf '%s' "${env_b64}" | grep -qE '^[A-Za-z0-9+/=]+$'; then
    log_err "Invalid base64 encoding"
    rm -f "${env_tmp}"
    return 1
  fi

  if printf '%s' "${env_b64}" | cloud_exec "${app_name}" "base64 -d > ~/.spawnrc && chmod 600 ~/.spawnrc && \
    for _rc in ~/.bashrc ~/.profile ~/.bash_profile; do \
    grep -q 'source ~/.spawnrc' \"\$_rc\" 2>/dev/null || printf '%s\n' '[ -f ~/.spawnrc ] && source ~/.spawnrc' >> \"\$_rc\"; done" >/dev/null 2>&1; then
    log_ok "Manual .spawnrc created successfully"
  else
    log_err "Failed to create manual .spawnrc"
  fi
  rm -f "${env_tmp}"
  return 0
}
