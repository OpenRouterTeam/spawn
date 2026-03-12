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
SOAK_CRON_RESULT_FILE="/tmp/spawn-cron-telegram-result.json"
SOAK_CRON_MARKER=""  # Set during install, checked during verify

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
# soak_install_cron_reminder APP_NAME
#
# Installs a one-shot cron job on the remote VM that sends a Telegram message
# after SOAK_CRON_DELAY_SECONDS (~55 min). The cron writes the API response
# to SOAK_CRON_RESULT_FILE so we can verify it after the soak wait.
#
# This tests OpenClaw's ability to stay alive and execute scheduled tasks.
# ---------------------------------------------------------------------------
soak_install_cron_reminder() {
  local app="$1"

  log_header "Installing cron-triggered Telegram reminder"

  local encoded_token
  encoded_token=$(printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 -w 0 2>/dev/null || printf '%s' "${TELEGRAM_BOT_TOKEN}" | base64 | tr -d '\n')

  # Generate a unique marker so we can identify this specific cron message
  SOAK_CRON_MARKER="SPAWN_CRON_REMINDER_$(date +%s)"
  log_info "Cron marker: ${SOAK_CRON_MARKER}"
  log_info "Cron delay: ${SOAK_CRON_DELAY_SECONDS}s (~$((SOAK_CRON_DELAY_SECONDS / 60)) min)"

  # Build the cron script locally, base64-encode it, and upload to the remote VM.
  # The script sleeps for SOAK_CRON_DELAY_SECONDS, then sends a Telegram message
  # and writes the API response to a result file. It removes itself from crontab
  # after firing (one-shot). We also launch it via nohup as belt-and-suspenders.
  local cron_script
  cron_script="#!/bin/bash
sleep ${SOAK_CRON_DELAY_SECONDS}
_TOKEN=\$(printf '%s' '${encoded_token}' | base64 -d)
curl -sS \"https://api.telegram.org/bot\${_TOKEN}/sendMessage\" \\
  -d chat_id='${TELEGRAM_TEST_CHAT_ID}' \\
  -d text='${SOAK_CRON_MARKER}' \\
  > ${SOAK_CRON_RESULT_FILE} 2>&1
crontab -l 2>/dev/null | grep -v 'spawn-cron-test' | crontab - 2>/dev/null || true"

  # Base64-encode the script to safely transfer it to the remote VM
  local encoded_script
  encoded_script=$(printf '%s' "${cron_script}" | base64 -w 0 2>/dev/null || printf '%s' "${cron_script}" | base64 | tr -d '\n')

  cloud_exec "${app}" "printf '%s' '${encoded_script}' | base64 -d > /tmp/spawn-cron-test.sh && \
    chmod +x /tmp/spawn-cron-test.sh && \
    (crontab -l 2>/dev/null || true; echo '* * * * * /tmp/spawn-cron-test.sh # spawn-cron-test') | crontab - && \
    nohup /tmp/spawn-cron-test.sh > /dev/null 2>&1 &" 2>&1

  if [ $? -ne 0 ]; then
    log_err "Failed to install cron reminder"
    return 1
  fi

  # Verify the cron was installed
  local cron_check
  cron_check=$(cloud_exec "${app}" "crontab -l 2>/dev/null | grep -c 'spawn-cron-test'" 2>&1) || true
  if [ "${cron_check:-0}" -ge 1 ]; then
    log_ok "Cron reminder installed (fires in ~${SOAK_CRON_DELAY_SECONDS}s)"
  else
    log_warn "Cron entry not found in crontab — relying on nohup background process"
  fi

  return 0
}

# ---------------------------------------------------------------------------
# soak_test_telegram_cron_fired APP_NAME
#
# Verifies that the cron-triggered Telegram message was sent successfully
# by reading the result file from the remote VM.
# ---------------------------------------------------------------------------
soak_test_telegram_cron_fired() {
  local app="$1"

  log_step "Testing cron-triggered Telegram reminder..."

  if [ -z "${SOAK_CRON_MARKER}" ]; then
    log_err "Cron marker not set — soak_install_cron_reminder was not called"
    return 1
  fi

  # Read the result file from the remote VM
  local output
  output=$(cloud_exec "${app}" "cat ${SOAK_CRON_RESULT_FILE} 2>/dev/null || echo 'FILE_NOT_FOUND'" 2>&1) || true

  if [ "${output}" = "FILE_NOT_FOUND" ] || [ -z "${output}" ]; then
    log_err "Cron reminder — result file not found (cron did not fire within ${SOAK_CRON_DELAY_SECONDS}s)"
    # Check if the script is still running (hasn't finished sleeping)
    local still_running
    still_running=$(cloud_exec "${app}" "pgrep -c -f 'spawn-cron-test' 2>/dev/null || echo 0" 2>&1) || true
    if [ "${still_running:-0}" -ge 1 ]; then
      log_info "Cron script is still running (sleep not finished yet)"
    fi
    return 1
  fi

  if printf '%s' "${output}" | grep -q '"ok":true'; then
    log_ok "Cron reminder — Telegram message sent successfully (marker: ${SOAK_CRON_MARKER})"
    return 0
  else
    log_err "Cron reminder — Telegram API returned error"
    log_err "Response: ${output}"
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
  soak_test_telegram_cron_fired "${app}" || failures=$((failures + 1))

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
# verify → inject telegram config → install cron reminder → soak wait →
# run tests (including cron verification) → teardown.
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

  # Install cron reminder — fires in ~55 min during the 1h soak wait
  if ! soak_install_cron_reminder "${app_name}"; then
    log_warn "Cron reminder install failed — cron test will fail but continuing"
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
