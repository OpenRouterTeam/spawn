#!/bin/bash
# e2e/lib/clouds/daytona.sh — Daytona cloud driver for multi-cloud E2E
set -eo pipefail

_DAYTONA_REPO_ROOT="${SPAWN_CLI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
_DAYTONA_E2E_HELPER="${_DAYTONA_REPO_ROOT}/packages/cli/src/daytona/e2e.ts"
_DAYTONA_SSH_HOST="ssh.app.daytona.io"

_daytona_helper() {
  if [ ! -f "${_DAYTONA_E2E_HELPER}" ]; then
    log_err "Daytona E2E helper not found: ${_DAYTONA_E2E_HELPER}"
    return 1
  fi

  bun run "${_DAYTONA_E2E_HELPER}" "$@"
}

_daytona_validate_env() {
  if ! command -v bun >/dev/null 2>&1; then
    log_err "bun is required for Daytona E2E"
    return 1
  fi

  if ! _daytona_helper validate >/dev/null 2>&1; then
    log_err "Daytona credentials are invalid or the API is unreachable"
    return 1
  fi

  log_ok "Daytona credentials validated"
}

_daytona_headless_env() {
  local app="$1"

  printf 'export DAYTONA_SANDBOX_NAME="%s"\n' "${app}"
  printf 'export DAYTONA_SANDBOX_SIZE="%s"\n' "${DAYTONA_SANDBOX_SIZE:-small}"
}

_daytona_provision_verify() {
  local app="$1"
  local log_dir="$2"
  local stdout_file="${log_dir}/${app}.stdout"

  local sandbox_id=""
  local sandbox_name=""

  if [ -f "${stdout_file}" ]; then
    sandbox_id=$(jq -r '.server_id // empty' "${stdout_file}" 2>/dev/null || true)
    sandbox_name=$(jq -r '.server_name // empty' "${stdout_file}" 2>/dev/null || true)
  fi

  if [ -z "${sandbox_id}" ]; then
    local lookup_json
    lookup_json=$(_daytona_helper find-by-name "${app}" 2>/dev/null || true)
    sandbox_id=$(printf '%s' "${lookup_json}" | jq -r '.id // empty' 2>/dev/null || true)
    sandbox_name=$(printf '%s' "${lookup_json}" | jq -r '.name // empty' 2>/dev/null || true)
  fi

  if [ -z "${sandbox_id}" ]; then
    log_err "Sandbox '${app}' not found after provisioning"
    return 1
  fi

  if [ -z "${sandbox_name}" ]; then
    sandbox_name="${app}"
  fi

  printf '%s' "${_DAYTONA_SSH_HOST}" > "${log_dir}/${app}.ip"
  printf '{"id":"%s","name":"%s"}\n' "${sandbox_id}" "${sandbox_name}" > "${log_dir}/${app}.meta"

  log_ok "Daytona sandbox verified: ${sandbox_id}"
}

_daytona_read_meta() {
  local app="$1"

  local meta_file="${LOG_DIR:-/tmp}/${app}.meta"
  if [ ! -f "${meta_file}" ]; then
    log_err "Meta file not found: ${meta_file}"
    return 1
  fi

  _DT_ID=$(jq -r '.id // empty' "${meta_file}" 2>/dev/null || true)
  _DT_NAME=$(jq -r '.name // empty' "${meta_file}" 2>/dev/null || true)

  if [ -z "${_DT_ID}" ]; then
    log_err "Sandbox ID not found in meta file for ${app}"
    return 1
  fi
}

_daytona_exec() {
  local app="$1"
  local cmd="$2"

  _daytona_read_meta "${app}" || return 1
  _daytona_helper exec "${_DT_ID}" "${cmd}"
}

_daytona_teardown() {
  local app="$1"

  _daytona_read_meta "${app}" || return 1

  if _daytona_helper delete "${_DT_ID}" >/dev/null 2>&1; then
    log_ok "Daytona sandbox ${_DT_NAME:-${app}} torn down"
  else
    log_warn "Daytona sandbox ${_DT_NAME:-${app}} may still exist"
  fi

  untrack_app "${app}"
}

_daytona_cleanup_stale() {
  local max_age="${_CLEANUP_MAX_AGE:-1800}"

  if _daytona_helper cleanup-stale "e2e-" "${max_age}" >/dev/null 2>&1; then
    log_ok "Daytona stale cleanup completed"
  else
    log_warn "Daytona stale cleanup failed"
  fi
}
