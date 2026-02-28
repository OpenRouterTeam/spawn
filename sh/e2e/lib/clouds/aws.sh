#!/bin/bash
# e2e/lib/clouds/aws.sh — AWS Lightsail cloud driver for multi-cloud E2E
#
# Implements the standard cloud driver interface (_aws_* prefixed functions).
# Sourced by common.sh's load_cloud_driver() which wires these to generic names.
#
# Depends on: log_step, log_ok, log_err, log_warn, log_info, format_duration,
#             untrack_app (provided by common.sh)
set -eo pipefail

# ---------------------------------------------------------------------------
# Instance IP cache (avoid repeated API calls within a single run)
# ---------------------------------------------------------------------------
_AWS_INSTANCE_IP=""
_AWS_INSTANCE_APP=""

# ---------------------------------------------------------------------------
# _aws_validate_env
#
# Check that the aws CLI is installed and credentials are valid.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_aws_validate_env() {
  local missing=0

  if ! command -v aws >/dev/null 2>&1; then
    log_err "aws CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    missing=1
  fi

  if [ "${missing}" -eq 1 ]; then
    return 1
  fi

  if ! aws sts get-caller-identity --region "${AWS_REGION:-us-east-1}" >/dev/null 2>&1; then
    log_err "AWS credentials are not valid. Run: aws configure"
    return 1
  fi

  log_ok "AWS credentials validated (region: ${AWS_REGION:-us-east-1})"
  return 0
}

# ---------------------------------------------------------------------------
# _aws_headless_env APP AGENT
#
# Print export lines to stdout for headless provisioning.
# These are eval'd by the provisioning harness before invoking the CLI.
# ---------------------------------------------------------------------------
_aws_headless_env() {
  local app="$1"
  local agent="${2:-}"

  # openclaw needs 4GB RAM — use medium_3_0 instead of nano
  local bundle="${AWS_BUNDLE:-nano_3_0}"
  if [ "${agent}" = "openclaw" ] && [ -z "${AWS_BUNDLE:-}" ]; then
    bundle="medium_3_0"
  fi

  printf 'export LIGHTSAIL_SERVER_NAME="%s"\n' "${app}"
  printf 'export AWS_DEFAULT_REGION="%s"\n' "${AWS_REGION:-us-east-1}"
  printf 'export LIGHTSAIL_BUNDLE="%s"\n' "${bundle}"
}

# ---------------------------------------------------------------------------
# _aws_provision_verify APP LOG_DIR
#
# Verify instance exists after provisioning, resolve public IP, and write
# metadata files for downstream steps (verify, teardown).
#
# Writes:
#   $LOG_DIR/$APP.ip    — public IPv4 address (plain text)
#   $LOG_DIR/$APP.meta  — instance metadata (JSON)
# ---------------------------------------------------------------------------
_aws_provision_verify() {
  local app="$1"
  local log_dir="$2"
  local region="${AWS_REGION:-us-east-1}"

  # Check instance exists
  if ! aws lightsail get-instance \
    --instance-name "${app}" \
    --region "${region}" >/dev/null 2>&1; then
    log_err "Instance ${app} does not exist after provisioning"
    return 1
  fi

  log_ok "Instance ${app} exists"

  # Resolve public IP
  local instance_ip
  instance_ip=$(aws lightsail get-instance \
    --instance-name "${app}" \
    --region "${region}" \
    --query 'instance.publicIpAddress' \
    --output text 2>/dev/null || true)

  if [ -z "${instance_ip}" ] || [ "${instance_ip}" = "None" ]; then
    log_err "Could not resolve public IP for ${app}"
    return 1
  fi

  log_ok "Instance IP: ${instance_ip}"

  # Write IP file for downstream steps
  printf '%s' "${instance_ip}" > "${log_dir}/${app}.ip"

  # Write metadata file
  printf '{"name":"%s","region":"%s","ip":"%s"}\n' \
    "${app}" "${region}" "${instance_ip}" \
    > "${log_dir}/${app}.meta"

  return 0
}

# ---------------------------------------------------------------------------
# _aws_exec APP CMD
#
# Resolve instance IP (cached), then run CMD via SSH.
# Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
_aws_exec() {
  local app="$1"
  local cmd="$2"

  # Resolve instance IP (cached per app)
  if [ "${_AWS_INSTANCE_APP}" != "${app}" ] || [ -z "${_AWS_INSTANCE_IP}" ]; then
    # Try reading from the IP file first (written by _aws_provision_verify)
    if [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/${app}.ip" ]; then
      _AWS_INSTANCE_IP=$(cat "${LOG_DIR}/${app}.ip")
    else
      _AWS_INSTANCE_IP=$(aws lightsail get-instance \
        --instance-name "${app}" \
        --region "${AWS_REGION:-us-east-1}" \
        --query 'instance.publicIpAddress' \
        --output text 2>/dev/null || true)
    fi
    _AWS_INSTANCE_APP="${app}"
    if [ -z "${_AWS_INSTANCE_IP}" ] || [ "${_AWS_INSTANCE_IP}" = "None" ]; then
      log_err "Could not resolve IP for instance ${app}"
      return 1
    fi
  fi

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      "ubuntu@${_AWS_INSTANCE_IP}" "${cmd}"
}

# ---------------------------------------------------------------------------
# _aws_exec_long APP CMD TIMEOUT
#
# Same as _aws_exec but with ServerAliveInterval keep-alives and the remote
# command wrapped in `timeout` for long-running operations.
# ---------------------------------------------------------------------------
_aws_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout="${3:-120}"

  # Resolve instance IP (cached per app)
  if [ "${_AWS_INSTANCE_APP}" != "${app}" ] || [ -z "${_AWS_INSTANCE_IP}" ]; then
    if [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/${app}.ip" ]; then
      _AWS_INSTANCE_IP=$(cat "${LOG_DIR}/${app}.ip")
    else
      _AWS_INSTANCE_IP=$(aws lightsail get-instance \
        --instance-name "${app}" \
        --region "${AWS_REGION:-us-east-1}" \
        --query 'instance.publicIpAddress' \
        --output text 2>/dev/null || true)
    fi
    _AWS_INSTANCE_APP="${app}"
    if [ -z "${_AWS_INSTANCE_IP}" ] || [ "${_AWS_INSTANCE_IP}" = "None" ]; then
      log_err "Could not resolve IP for instance ${app}"
      return 1
    fi
  fi

  local alive_count=$((timeout / 15 + 1))

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      -o "ServerAliveInterval=15" -o "ServerAliveCountMax=${alive_count}" \
      "ubuntu@${_AWS_INSTANCE_IP}" "timeout ${timeout} bash -c '${cmd}'"
}

# ---------------------------------------------------------------------------
# _aws_teardown APP
#
# Delete the Lightsail instance, verify deletion, and untrack it.
# ---------------------------------------------------------------------------
_aws_teardown() {
  local app="$1"
  local region="${AWS_REGION:-us-east-1}"

  log_step "Tearing down ${app}..."

  # Delete the instance
  aws lightsail delete-instance \
    --instance-name "${app}" \
    --region "${region}" \
    --force-delete-add-ons \
    >/dev/null 2>&1 || true

  # Brief wait for deletion to propagate
  sleep 2

  # Verify deletion
  if aws lightsail get-instance --instance-name "${app}" --region "${region}" >/dev/null 2>&1; then
    log_warn "Instance ${app} may still exist (AWS still reports it)"
  else
    log_ok "Instance ${app} torn down"
  fi

  # Clear IP cache if this was the cached instance
  if [ "${_AWS_INSTANCE_APP}" = "${app}" ]; then
    _AWS_INSTANCE_IP=""
    _AWS_INSTANCE_APP=""
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _aws_cleanup_stale
#
# List all Lightsail instances, filter for e2e-* names, and destroy any
# older than 30 minutes (based on the unix timestamp embedded in the name).
# ---------------------------------------------------------------------------
_aws_cleanup_stale() {
  local region="${AWS_REGION:-us-east-1}"
  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  # List all instances
  local instances_json
  instances_json=$(aws lightsail get-instances \
    --region "${region}" \
    --query 'instances[].name' \
    --output json 2>/dev/null || true)

  if [ -z "${instances_json}" ] || [ "${instances_json}" = "null" ] || [ "${instances_json}" = "[]" ]; then
    log_info "Could not list instances or no instances found — skipping cleanup"
    return 0
  fi

  # Extract instance names matching e2e-* pattern
  local instance_names
  instance_names=$(printf '%s' "${instances_json}" | jq -r '.[]? // empty' 2>/dev/null | grep '^e2e-' || true)

  if [ -z "${instance_names}" ]; then
    log_ok "No stale e2e instances found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  for instance_name in ${instance_names}; do
    # Extract timestamp from name: e2e-AGENT-TIMESTAMP
    # The timestamp is the last dash-separated segment
    local ts
    ts=$(printf '%s' "${instance_name}" | sed 's/.*-//')

    # Validate it looks like a unix timestamp (all digits, 10 chars)
    if ! printf '%s' "${ts}" | grep -qE '^[0-9]{10}$'; then
      log_warn "Skipping ${instance_name} — cannot parse timestamp"
      skipped=$((skipped + 1))
      continue
    fi

    local age=$((now - ts))
    if [ "${age}" -gt "${max_age}" ]; then
      local age_str
      age_str=$(format_duration "${age}")
      log_step "Destroying stale instance ${instance_name} (age: ${age_str})"
      _aws_teardown "${instance_name}" || log_warn "Failed to tear down ${instance_name}"
      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale instance(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent instance(s)"
  fi
}
