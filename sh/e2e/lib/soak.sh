#!/bin/bash
# e2e/lib/soak.sh — Telegram soak test for OpenClaw
#
# Provisions OpenClaw on Sprite, waits for stabilization, injects a Telegram
# bot token, installs a cron-triggered reminder, and runs integration tests
# against the Telegram Bot API — including verifying the cron fired.
#
# Required env vars:
#   TELEGRAM_BOT_TOKEN      — Bot token from @BotFather
#   TELEGRAM_TEST_CHAT_ID   — Chat ID to send test messages to
#
# Optional env vars:
#   SOAK_WAIT_SECONDS       — Override the default 1-hour soak wait (default: 3600)
#   SOAK_CRON_DELAY_SECONDS — Delay before cron fires (default: 3300 = 55 min)
set -eo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SOAK_WAIT_SECONDS="${SOAK_WAIT_SECONDS:-3600}"
SOAK_CRON_DELAY_SECONDS="${SOAK_CRON_DELAY_SECONDS:-3300}"
SOAK_HEARTBEAT_INTERVAL=300  # 5 minutes
SOAK_GATEWAY_PORT=18789
TELEGRAM_API_BASE="https://api.telegram.org"
SOAK_CRON_JOB_NAME="spawn-soak-reminder"  # OpenClaw cron job name

# ---------------------------------------------------------------------------
# soak_validate_telegram_env
#
# Checks that TELEGRAM_BOT_TOKEN and TELEGRAM_TEST_CHAT_ID are set.
# ---------------------------------------------------------------------------
soak_validate_telegram_env() {
  local missing=0

  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    log_err "TELEGRAM_BOT_TOKEN is not set"
    missing=1
  fi

  if [ -z "${TELEGRAM_TEST_CHAT_ID:-}" ]; then
    log_err "TELEGRAM_TEST_CHAT_ID is not set"
    missing=1
  fi

  if [ "${missing}" -eq 1 ]; then
    return 1
  fi

  log_ok "Telegram env validated (token + chat ID present)"
  return 0
}

# ---------------------------------------------------------------------------
# soak_wait APP_NAME
#
# Sleeps for SOAK_WAIT_SECONDS with a heartbeat every 5 minutes.
# Each heartbeat checks gateway port 18789 is still listening.
# ---------------------------------------------------------------------------
soak_wait() {
  local app="$1"
  local elapsed=0
  local port_check='ss -tln 2>/dev/null | grep -q ":18789 " || (echo >/dev/tcp/127.0.0.1/18789) 2>/dev/null || nc -z 127.0.0.1 18789 2>/dev/null'

  log_header "Soak wait: ${SOAK_WAIT_SECONDS}s (heartbeat every ${SOAK_HEARTBEAT_INTERVAL}s)"

  while [ "${elapsed}" -lt "${SOAK_WAIT_SECONDS}" ]; do
    local remaining=$((SOAK_WAIT_SECONDS - elapsed))
    local sleep_time="${SOAK_HEARTBEAT_INTERVAL}"
    if [ "${remaining}" -lt "${sleep_time}" ]; then
      sleep_time="${remaining}"
    fi

    sleep "${sleep_time}"
    elapsed=$((elapsed + sleep_time))

    # Heartbeat: check gateway is alive
    if cloud_exec "${app}" "${port_check}" >/dev/null 2>&1; then
      log_info "Heartbeat ${elapsed}/${SOAK_WAIT_SECONDS}s — gateway alive on :${SOAK_GATEWAY_PORT}"
    else
      log_warn "Heartbeat ${elapsed}/${SOAK_WAIT_SECONDS}s — gateway NOT responding on :${SOAK_GATEWAY_PORT}"
    fi
  done

  log_ok "Soak wait complete (${SOAK_WAIT_SECONDS}s)"
}

# ---------------------------------------------------------------------------
# soak_inject_telegram_config APP_NAME
#
# Injects TELEGRAM_BOT_TOKEN into ~/.openclaw/openclaw.json on the remote VM,
# then restarts the gateway to pick up the new config.
# ---------------------------------------------------------------------------
soak_inject_telegram_config() {
  local app="$1"

  log_header "Injecting Telegram config"

  # Base64-encode the token to avoid shell metacharacter issues
  local encoded_token
  encoded_token=$(printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 -w 0 2>/dev/null || printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 | tr -d '\n')

  log_step "Patching ~/.openclaw/openclaw.json with Telegram bot token..."

  # Use bun eval on the remote to JSON-patch the config file
  cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    _TOKEN=\$(printf '%s' '${encoded_token}' | base64 -d); \
    bun eval ' \
      import { mkdirSync, readFileSync, writeFileSync } from \"node:fs\"; \
      import { dirname } from \"node:path\"; \
      const configPath = process.env.HOME + \"/.openclaw/openclaw.json\"; \
      let config = {}; \
      try { config = JSON.parse(readFileSync(configPath, \"utf-8\")); } catch {} \
      if (!config.channels) config.channels = {}; \
      if (!config.channels.telegram) config.channels.telegram = {}; \
      config.channels.telegram.botToken = process.env._TOKEN; \
      mkdirSync(dirname(configPath), { recursive: true }); \
      writeFileSync(configPath, JSON.stringify(config, null, 2)); \
      console.log(\"Telegram config injected\"); \
    '" >/dev/null 2>&1

  if [ $? -ne 0 ]; then
    log_err "Failed to inject Telegram config"
    return 1
  fi
  log_ok "Telegram bot token injected into openclaw.json"

  # Restart gateway to pick up new config
  _openclaw_restart_gateway "${app}"
}

# ---------------------------------------------------------------------------
# soak_test_telegram_getme APP_NAME
#
# Calls Telegram getMe API from the remote VM to verify the bot token is valid.
# ---------------------------------------------------------------------------
soak_test_telegram_getme() {
  local app="$1"

  log_step "Testing Telegram getMe API..."

  local encoded_token
  encoded_token=$(printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 -w 0 2>/dev/null || printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 | tr -d '\n')

  local output
  output=$(cloud_exec "${app}" "_TOKEN=\$(printf '%s' '${encoded_token}' | base64 -d); \
    curl -sS \"https://api.telegram.org/bot\${_TOKEN}/getMe\"" 2>&1) || true

  if printf '%s' "${output}" | grep -q '"ok":true'; then
    log_ok "Telegram getMe — bot token is valid"
    return 0
  else
    log_err "Telegram getMe — unexpected response"
    log_err "Response: ${output}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# soak_test_telegram_send APP_NAME
#
# Sends a timestamped test message to TELEGRAM_TEST_CHAT_ID.
# ---------------------------------------------------------------------------
soak_test_telegram_send() {
  local app="$1"

  log_step "Testing Telegram sendMessage API..."

  local encoded_token
  encoded_token=$(printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 -w 0 2>/dev/null || printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 | tr -d '\n')

  local marker
  marker="SPAWN_SOAK_TEST_$(date +%s)"

  local output
  output=$(cloud_exec "${app}" "_TOKEN=\$(printf '%s' '${encoded_token}' | base64 -d); \
    curl -sS \"https://api.telegram.org/bot\${_TOKEN}/sendMessage\" \
      -d chat_id='${TELEGRAM_TEST_CHAT_ID}' \
      -d text='${marker}'" 2>&1) || true

  if printf '%s' "${output}" | grep -q '"ok":true'; then
    log_ok "Telegram sendMessage — message sent (marker: ${marker})"
    return 0
  else
    log_err "Telegram sendMessage — failed to send message"
    log_err "Response: ${output}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# soak_test_telegram_webhook APP_NAME
#
# Calls getWebhookInfo to verify gateway registered a webhook (or is polling).
# ---------------------------------------------------------------------------
soak_test_telegram_webhook() {
  local app="$1"

  log_step "Testing Telegram getWebhookInfo API..."

  local encoded_token
  encoded_token=$(printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 -w 0 2>/dev/null || printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 | tr -d '\n')

  local output
  output=$(cloud_exec "${app}" "_TOKEN=\$(printf '%s' '${encoded_token}' | base64 -d); \
    curl -sS \"https://api.telegram.org/bot\${_TOKEN}/getWebhookInfo\"" 2>&1) || true

  if printf '%s' "${output}" | grep -q '"ok":true'; then
    log_ok "Telegram getWebhookInfo — responded OK"
    # Log webhook URL if set (informational — polling mode has empty url)
    local webhook_url
    webhook_url=$(printf '%s' "${output}" | grep -o '"url":"[^"]*"' | head -1) || true
    if [ -n "${webhook_url}" ]; then
      log_info "Webhook info: ${webhook_url}"
    else
      log_info "No webhook URL set — bot is likely in polling mode"
    fi
    return 0
  else
    log_err "Telegram getWebhookInfo — unexpected response"
    log_err "Response: ${output}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# soak_install_openclaw_cron APP_NAME
#
# Uses OpenClaw's built-in cron scheduler to create a one-shot reminder that
# sends a Telegram message after SOAK_CRON_DELAY_SECONDS (~55 min).
#
# This tests that OpenClaw's gateway stays alive and its cron system can
# execute scheduled tasks and deliver messages to Telegram.
#
# Uses: openclaw cron add --at <ISO8601> --channel telegram --announce
# Verify: openclaw cron runs <name> after soak wait
# ---------------------------------------------------------------------------
soak_install_openclaw_cron() {
  local app="$1"

  log_header "Scheduling OpenClaw cron reminder"
  log_info "Job name: ${SOAK_CRON_JOB_NAME}"
  log_info "Delay: ${SOAK_CRON_DELAY_SECONDS}s (~$((SOAK_CRON_DELAY_SECONDS / 60)) min)"

  # Compute the ISO 8601 fire time on the remote VM (uses its clock, not ours)
  local fire_at
  fire_at=$(cloud_exec "${app}" "date -u -d '+${SOAK_CRON_DELAY_SECONDS} seconds' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
    date -u -v+${SOAK_CRON_DELAY_SECONDS}S '+%Y-%m-%dT%H:%M:%SZ'" 2>&1) || true

  if [ -z "${fire_at}" ]; then
    log_err "Failed to compute fire time on remote VM"
    return 1
  fi
  log_info "Fire at: ${fire_at} (UTC)"

  # Create the cron job via OpenClaw's CLI
  # --at: one-shot at a specific time
  # --session isolated: runs in its own session (doesn't block main conversation)
  # --channel telegram: deliver via Telegram
  # --to: target the test chat
  # --announce: post the message to the channel
  # --delete-after-run: clean up after firing (one-shot)
  local output
  output=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    openclaw cron add \
      --name '${SOAK_CRON_JOB_NAME}' \
      --at '${fire_at}' \
      --session isolated \
      --message 'Spawn soak test: scheduled reminder fired successfully at \$(date -u)' \
      --announce \
      --channel telegram \
      --to 'chat:${TELEGRAM_TEST_CHAT_ID}' \
      --delete-after-run" 2>&1) || true

  if printf '%s' "${output}" | grep -qi 'error\|fail\|not found\|unknown'; then
    log_err "Failed to create OpenClaw cron job"
    log_err "Output: ${output}"
    return 1
  fi

  log_ok "OpenClaw cron job scheduled (fires at ${fire_at})"

  # Verify the job exists via openclaw cron list
  local list_output
  list_output=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    openclaw cron list" 2>&1) || true

  if printf '%s' "${list_output}" | grep -q "${SOAK_CRON_JOB_NAME}"; then
    log_ok "Cron job '${SOAK_CRON_JOB_NAME}' confirmed in openclaw cron list"
  else
    log_warn "Cron job not visible in openclaw cron list — may still work"
    log_info "List output: ${list_output}"
  fi

  return 0
}

# ---------------------------------------------------------------------------
# soak_test_openclaw_cron_fired APP_NAME
#
# Verifies that the OpenClaw cron job executed and delivered a Telegram
# message by checking the job's execution history via `openclaw cron runs`.
# ---------------------------------------------------------------------------
soak_test_openclaw_cron_fired() {
  local app="$1"

  log_step "Testing OpenClaw cron-triggered Telegram reminder..."

  # Check execution history for the cron job
  local runs_output
  runs_output=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
    export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
    openclaw cron runs '${SOAK_CRON_JOB_NAME}'" 2>&1) || true

  if [ -z "${runs_output}" ]; then
    log_err "OpenClaw cron — no output from 'openclaw cron runs'"
    # Fall back: check job status
    local status_output
    status_output=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
      export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
      openclaw cron status '${SOAK_CRON_JOB_NAME}'" 2>&1) || true
    log_info "Job status: ${status_output}"
    return 1
  fi

  # Check for successful execution — look for success/completed/ok indicators
  if printf '%s' "${runs_output}" | grep -qiE 'success|completed|ok|delivered'; then
    log_ok "OpenClaw cron — job executed and delivered successfully"
    return 0
  elif printf '%s' "${runs_output}" | grep -qiE 'fail|error|timeout'; then
    log_err "OpenClaw cron — job executed but failed"
    log_err "Runs output: ${runs_output}"
    return 1
  elif printf '%s' "${runs_output}" | grep -qiE 'pending|scheduled|waiting'; then
    log_err "OpenClaw cron — job has not fired yet (still pending)"
    log_info "Runs output: ${runs_output}"
    return 1
  else
    # Job has run history but unclear result — check if delete-after-run cleaned it
    # If the job was deleted (--delete-after-run), it executed successfully
    local list_output
    list_output=$(cloud_exec "${app}" "source ~/.spawnrc 2>/dev/null; \
      export PATH=\$HOME/.npm-global/bin:\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH; \
      openclaw cron list" 2>&1) || true

    if ! printf '%s' "${list_output}" | grep -q "${SOAK_CRON_JOB_NAME}"; then
      log_ok "OpenClaw cron — job auto-deleted after run (--delete-after-run confirms execution)"
      return 0
    fi

    log_warn "OpenClaw cron — ambiguous result"
    log_info "Runs output: ${runs_output}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# soak_run_telegram_tests APP_NAME
#
# Runs all 4 Telegram tests and returns the failure count.
# ---------------------------------------------------------------------------
soak_run_telegram_tests() {
  local app="$1"
  local failures=0

  local total=4
  log_header "Telegram Integration Tests (${total} tests)"

  soak_test_telegram_getme "${app}" || failures=$((failures + 1))
  soak_test_telegram_send "${app}" || failures=$((failures + 1))
  soak_test_telegram_webhook "${app}" || failures=$((failures + 1))
  soak_test_openclaw_cron_fired "${app}" || failures=$((failures + 1))

  if [ "${failures}" -eq 0 ]; then
    log_ok "All ${total} Telegram tests passed"
  else
    log_err "${failures}/${total} Telegram test(s) failed"
  fi

  return "${failures}"
}

# ---------------------------------------------------------------------------
# run_soak_test [LOG_DIR]
#
# Orchestrator: validate env → load sprite driver → provision openclaw →
# verify → inject telegram config → schedule openclaw cron reminder →
# soak wait → run tests (including openclaw cron verification) → teardown.
# ---------------------------------------------------------------------------
run_soak_test() {
  local log_dir="${1:-${LOG_DIR:-}}"
  if [ -z "${log_dir}" ]; then
    log_dir=$(mktemp -d "${TMPDIR:-/tmp}/spawn-soak.XXXXXX")
  fi

  log_header "Spawn Soak Test: OpenClaw + Telegram (with cron reminder)"
  log_info "Soak wait: ${SOAK_WAIT_SECONDS}s"
  log_info "Cron delay: ${SOAK_CRON_DELAY_SECONDS}s"

  # Validate Telegram secrets
  if ! soak_validate_telegram_env; then
    log_err "Soak test aborted — missing Telegram env vars"
    return 1
  fi

  # Load sprite cloud driver
  load_cloud_driver "sprite"

  # Validate cloud environment
  if ! require_env; then
    log_err "Soak test aborted — cloud env validation failed"
    return 1
  fi

  # Provision OpenClaw
  local app_name
  app_name=$(make_app_name "openclaw")
  track_app "${app_name}"

  local soak_start
  soak_start=$(date +%s)

  if ! provision_agent "openclaw" "${app_name}" "${log_dir}"; then
    log_err "Soak test aborted — provisioning failed"
    teardown_agent "${app_name}" || log_warn "Teardown failed for ${app_name}"
    return 1
  fi

  # Standard verification
  if ! verify_agent "openclaw" "${app_name}"; then
    log_err "Soak test aborted — verification failed"
    teardown_agent "${app_name}" || log_warn "Teardown failed for ${app_name}"
    return 1
  fi

  # Inject Telegram config BEFORE soak wait so cron can use the bot token
  if ! soak_inject_telegram_config "${app_name}"; then
    log_err "Soak test aborted — Telegram config injection failed"
    teardown_agent "${app_name}" || log_warn "Teardown failed for ${app_name}"
    return 1
  fi

  # Schedule OpenClaw cron reminder — fires in ~55 min during the 1h soak wait
  if ! soak_install_openclaw_cron "${app_name}"; then
    log_warn "OpenClaw cron install failed — cron test will fail but continuing"
  fi

  # Soak wait — gateway heartbeat + cron fires during this window
  soak_wait "${app_name}"

  # Run Telegram tests (including cron verification)
  local test_failures=0
  soak_run_telegram_tests "${app_name}" || test_failures=$?

  # Teardown
  teardown_agent "${app_name}" || log_warn "Teardown failed for ${app_name}"

  # Summary
  local soak_end
  soak_end=$(date +%s)
  local soak_duration=$((soak_end - soak_start))
  local duration_str
  duration_str=$(format_duration "${soak_duration}")

  printf "\n"
  log_header "Soak Test Summary"
  if [ "${test_failures}" -eq 0 ]; then
    log_ok "All Telegram tests passed (${duration_str})"
  else
    log_err "${test_failures} Telegram test(s) failed (${duration_str})"
  fi

  return "${test_failures}"
}
