#!/bin/bash
# e2e/lib/clouds/gcp.sh — GCP Compute Engine cloud driver for multi-cloud E2E
#
# Implements the standard cloud driver interface (_gcp_* prefixed functions).
# Sourced by common.sh's load_cloud_driver() which wires these to generic names.
#
# Depends on: log_step, log_ok, log_err, log_warn, log_info, format_duration,
#             untrack_app (provided by common.sh)
set -eo pipefail

# ---------------------------------------------------------------------------
# Instance IP cache (avoid repeated API calls within a single run)
# ---------------------------------------------------------------------------
_GCP_INSTANCE_IP=""
_GCP_INSTANCE_APP=""

# ---------------------------------------------------------------------------
# _gcp_validate_env
#
# Check that the gcloud CLI is installed and credentials are valid.
# Requires GCP_PROJECT to be set.
# Returns 0 on success, 1 on failure.
# ---------------------------------------------------------------------------
_gcp_validate_env() {
  local missing=0

  if ! command -v gcloud >/dev/null 2>&1; then
    log_err "gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install"
    missing=1
  fi

  if [ -z "${GCP_PROJECT:-}" ]; then
    log_err "GCP_PROJECT is not set"
    missing=1
  fi

  if [ "${missing}" -eq 1 ]; then
    return 1
  fi

  if ! gcloud auth print-identity-token >/dev/null 2>&1; then
    log_err "GCP credentials are not valid. Run: gcloud auth login"
    return 1
  fi

  log_ok "GCP credentials validated (project: ${GCP_PROJECT}, zone: ${GCP_ZONE:-us-central1-a})"
  return 0
}

# ---------------------------------------------------------------------------
# _gcp_headless_env APP AGENT
#
# Print export lines to stdout for headless provisioning.
# These are eval'd by the provisioning harness before invoking the CLI.
# ---------------------------------------------------------------------------
_gcp_headless_env() {
  local app="$1"
  # local agent="$2"  # unused but part of the interface

  printf 'export GCP_INSTANCE_NAME="%s"\n' "${app}"
  printf 'export GCP_PROJECT="%s"\n' "${GCP_PROJECT:-}"
  printf 'export GCP_ZONE="%s"\n' "${GCP_ZONE:-us-central1-a}"
  printf 'export GCP_MACHINE_TYPE="%s"\n' "${GCP_MACHINE_TYPE:-e2-standard-2}"
}

# ---------------------------------------------------------------------------
# _gcp_provision_verify APP LOG_DIR
#
# Verify instance exists after provisioning, resolve external IP, and write
# metadata files for downstream steps (verify, teardown).
#
# Writes:
#   $LOG_DIR/$APP.ip    — external IPv4 address (plain text)
#   $LOG_DIR/$APP.meta  — instance metadata (JSON: name, zone, project)
# ---------------------------------------------------------------------------
_gcp_provision_verify() {
  local app="$1"
  local log_dir="$2"
  local zone="${GCP_ZONE:-us-central1-a}"
  local project="${GCP_PROJECT:-}"

  # Check instance exists
  if ! gcloud compute instances describe "${app}" \
    --zone="${zone}" \
    --project="${project}" >/dev/null 2>&1; then
    log_err "Instance ${app} does not exist after provisioning"
    return 1
  fi

  log_ok "Instance ${app} exists"

  # Resolve external IP from networkInterfaces
  local instance_ip
  instance_ip=$(gcloud compute instances describe "${app}" \
    --zone="${zone}" \
    --project="${project}" \
    --format=json 2>/dev/null \
    | jq -r '.networkInterfaces[0].accessConfigs[0].natIP // empty' 2>/dev/null || true)

  if [ -z "${instance_ip}" ]; then
    log_err "Could not resolve external IP for ${app}"
    return 1
  fi

  log_ok "Instance IP: ${instance_ip}"

  # Write IP file for downstream steps
  printf '%s' "${instance_ip}" > "${log_dir}/${app}.ip"

  # Write metadata file
  printf '{"name":"%s","zone":"%s","project":"%s"}\n' \
    "${app}" "${zone}" "${project}" \
    > "${log_dir}/${app}.meta"

  return 0
}

# ---------------------------------------------------------------------------
# _gcp_exec APP CMD
#
# Resolve instance IP (cached), then run CMD via SSH.
# Returns the exit code of the remote command.
# ---------------------------------------------------------------------------
_gcp_exec() {
  local app="$1"
  local cmd="$2"
  local ssh_user="${GCP_SSH_USER:-$(whoami)}"

  # Resolve instance IP (cached per app)
  if [ "${_GCP_INSTANCE_APP}" != "${app}" ] || [ -z "${_GCP_INSTANCE_IP}" ]; then
    # Try reading from the IP file first (written by _gcp_provision_verify)
    if [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/${app}.ip" ]; then
      _GCP_INSTANCE_IP=$(cat "${LOG_DIR}/${app}.ip")
    else
      _GCP_INSTANCE_IP=$(gcloud compute instances describe "${app}" \
        --zone="${GCP_ZONE:-us-central1-a}" \
        --project="${GCP_PROJECT:-}" \
        --format=json 2>/dev/null \
        | jq -r '.networkInterfaces[0].accessConfigs[0].natIP // empty' 2>/dev/null || true)
    fi
    _GCP_INSTANCE_APP="${app}"
    if [ -z "${_GCP_INSTANCE_IP}" ]; then
      log_err "Could not resolve IP for instance ${app}"
      return 1
    fi
  fi

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      "${ssh_user}@${_GCP_INSTANCE_IP}" "${cmd}"
}

# ---------------------------------------------------------------------------
# _gcp_exec_long APP CMD TIMEOUT
#
# Same as _gcp_exec but with ServerAliveInterval keep-alives and the remote
# command wrapped in `timeout` for long-running operations.
# ---------------------------------------------------------------------------
_gcp_exec_long() {
  local app="$1"
  local cmd="$2"
  local timeout="${3:-120}"
  local ssh_user="${GCP_SSH_USER:-$(whoami)}"

  # Resolve instance IP (cached per app)
  if [ "${_GCP_INSTANCE_APP}" != "${app}" ] || [ -z "${_GCP_INSTANCE_IP}" ]; then
    if [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/${app}.ip" ]; then
      _GCP_INSTANCE_IP=$(cat "${LOG_DIR}/${app}.ip")
    else
      _GCP_INSTANCE_IP=$(gcloud compute instances describe "${app}" \
        --zone="${GCP_ZONE:-us-central1-a}" \
        --project="${GCP_PROJECT:-}" \
        --format=json 2>/dev/null \
        | jq -r '.networkInterfaces[0].accessConfigs[0].natIP // empty' 2>/dev/null || true)
    fi
    _GCP_INSTANCE_APP="${app}"
    if [ -z "${_GCP_INSTANCE_IP}" ]; then
      log_err "Could not resolve IP for instance ${app}"
      return 1
    fi
  fi

  local alive_count=$((timeout / 15 + 1))

  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 -o LogLevel=ERROR -o BatchMode=yes \
      -o "ServerAliveInterval=15" -o "ServerAliveCountMax=${alive_count}" \
      "${ssh_user}@${_GCP_INSTANCE_IP}" "timeout ${timeout} bash -c '${cmd}'"
}

# ---------------------------------------------------------------------------
# _gcp_teardown APP
#
# Delete the GCP Compute Engine instance, verify deletion, and untrack it.
# Reads zone/project from metadata file if available, falls back to env vars.
# ---------------------------------------------------------------------------
_gcp_teardown() {
  local app="$1"
  local zone="${GCP_ZONE:-us-central1-a}"
  local project="${GCP_PROJECT:-}"

  # Try reading zone/project from metadata file
  if [ -n "${LOG_DIR:-}" ] && [ -f "${LOG_DIR}/${app}.meta" ]; then
    local meta_zone
    local meta_project
    meta_zone=$(jq -r '.zone // empty' "${LOG_DIR}/${app}.meta" 2>/dev/null || true)
    meta_project=$(jq -r '.project // empty' "${LOG_DIR}/${app}.meta" 2>/dev/null || true)
    if [ -n "${meta_zone}" ]; then
      zone="${meta_zone}"
    fi
    if [ -n "${meta_project}" ]; then
      project="${meta_project}"
    fi
  fi

  log_step "Tearing down ${app}..."

  # Delete the instance
  gcloud compute instances delete "${app}" \
    --zone="${zone}" \
    --project="${project}" \
    --quiet >/dev/null 2>&1 || true

  # Brief wait for deletion to propagate
  sleep 2

  # Verify deletion
  if gcloud compute instances describe "${app}" \
    --zone="${zone}" \
    --project="${project}" >/dev/null 2>&1; then
    log_warn "Instance ${app} may still exist (GCP still reports it)"
  else
    log_ok "Instance ${app} torn down"
  fi

  # Clear IP cache if this was the cached instance
  if [ "${_GCP_INSTANCE_APP}" = "${app}" ]; then
    _GCP_INSTANCE_IP=""
    _GCP_INSTANCE_APP=""
  fi

  untrack_app "${app}"
}

# ---------------------------------------------------------------------------
# _gcp_cleanup_stale
#
# List all GCP Compute Engine instances matching e2e-* in the project,
# and destroy any older than 30 minutes (based on the unix timestamp
# embedded in the name).
# ---------------------------------------------------------------------------
_gcp_cleanup_stale() {
  local project="${GCP_PROJECT:-}"
  local now
  now=$(date +%s)
  local max_age=1800  # 30 minutes in seconds

  if [ -z "${project}" ]; then
    log_warn "GCP_PROJECT not set — skipping stale cleanup"
    return 0
  fi

  # List all instances matching e2e-* across all zones
  local instances_json
  instances_json=$(gcloud compute instances list \
    --filter="name~^e2e-" \
    --project="${project}" \
    --format=json 2>/dev/null || true)

  if [ -z "${instances_json}" ] || [ "${instances_json}" = "null" ] || [ "${instances_json}" = "[]" ]; then
    log_info "Could not list instances or no e2e instances found — skipping cleanup"
    return 0
  fi

  # Extract instance names and zones
  local instance_entries
  instance_entries=$(printf '%s' "${instances_json}" | jq -r '.[]? | "\(.name) \(.zone)"' 2>/dev/null || true)

  if [ -z "${instance_entries}" ]; then
    log_ok "No stale e2e instances found"
    return 0
  fi

  local cleaned=0
  local skipped=0

  while IFS= read -r entry; do
    local instance_name
    local instance_zone_url
    instance_name=$(printf '%s' "${entry}" | awk '{print $1}')
    instance_zone_url=$(printf '%s' "${entry}" | awk '{print $2}')

    # Extract zone name from full URL (zones/us-central1-a -> us-central1-a)
    local instance_zone
    instance_zone=$(printf '%s' "${instance_zone_url}" | sed 's|.*/||')

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
      log_step "Destroying stale instance ${instance_name} (zone: ${instance_zone}, age: ${age_str})"

      # Directly delete with the instance's actual zone
      gcloud compute instances delete "${instance_name}" \
        --zone="${instance_zone}" \
        --project="${project}" \
        --quiet >/dev/null 2>&1 || log_warn "Failed to tear down ${instance_name}"

      cleaned=$((cleaned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done <<EOF
${instance_entries}
EOF

  if [ "${cleaned}" -gt 0 ]; then
    log_ok "Cleaned ${cleaned} stale instance(s)"
  fi
  if [ "${skipped}" -gt 0 ]; then
    log_info "Skipped ${skipped} recent instance(s)"
  fi
}
