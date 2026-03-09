#!/bin/bash
set -eo pipefail

# capture-agent.sh — Capture installed agent files into a tarball.
# Usage: capture-agent.sh <agent-name>
# Output: /tmp/spawn-agent-<name>.tar.gz

AGENT_NAME="${1:-}"
if [ -z "${AGENT_NAME}" ]; then
  echo "Usage: capture-agent.sh <agent-name>" >&2
  exit 1
fi

# Validate agent name against allowed list to prevent injection
case "${AGENT_NAME}" in
  openclaw|codex|kilocode|claude|opencode|zeroclaw|hermes) ;;
  *)
    printf 'Error: Invalid agent name: %s\nAllowed: openclaw, codex, kilocode, claude, opencode, zeroclaw, hermes\n' "${AGENT_NAME}" >&2
    exit 1
    ;;
esac

PATHS_FILE="/tmp/spawn-tarball-paths.txt"
: > "${PATHS_FILE}"

# Map agent -> filesystem paths to capture (all relative to /)
case "${AGENT_NAME}" in
  openclaw)
    echo "/root/.npm-global/" >> "${PATHS_FILE}"
    # Google Chrome for OpenClaw's browser tool (CDP automation)
    echo "/usr/bin/google-chrome-stable" >> "${PATHS_FILE}"
    echo "/usr/bin/google-chrome" >> "${PATHS_FILE}"
    echo "/opt/google/chrome/" >> "${PATHS_FILE}"
    ;;
  codex|kilocode)
    echo "/root/.npm-global/" >> "${PATHS_FILE}"
    ;;
  claude)
    echo "/root/.claude/local/" >> "${PATHS_FILE}"
    echo "/root/.local/bin/" >> "${PATHS_FILE}"
    echo "/root/.local/share/claude/" >> "${PATHS_FILE}"
    echo "/root/.npm-global/" >> "${PATHS_FILE}"
    ;;
  opencode)
    echo "/root/.opencode/" >> "${PATHS_FILE}"
    ;;
  zeroclaw)
    echo "/root/.cargo/bin/zeroclaw" >> "${PATHS_FILE}"
    ;;
  hermes)
    echo "/root/.local/bin/hermes" >> "${PATHS_FILE}"
    echo "/root/.local/share/" >> "${PATHS_FILE}"
    # The hermes installer (uv tool) creates the actual binary + venv under ~/.hermes/.
    # Without this, the ~/.local/bin/hermes symlink is dangling after tarball extraction.
    echo "/root/.hermes/" >> "${PATHS_FILE}"
    ;;
  *)
    echo "Unknown agent: ${AGENT_NAME}" >&2
    exit 1
    ;;
esac

# Create marker file with agent name + build date
MARKER_FILE="/root/.spawn-tarball"
printf '%s\n%s\n' "${AGENT_NAME}" "$(date -u +%Y%m%dT%H%M%SZ)" > "${MARKER_FILE}"
echo "${MARKER_FILE}" >> "${PATHS_FILE}"

# Filter to only paths that exist (use a temp file to avoid word-splitting)
FILTERED_FILE="/tmp/spawn-tarball-filtered.txt"
: > "${FILTERED_FILE}"
while IFS= read -r p; do
  [ -z "${p}" ] && continue
  if [ -e "${p}" ]; then
    echo "${p}" >> "${FILTERED_FILE}"
  else
    echo "Warning: ${p} does not exist, skipping" >&2
  fi
done < "${PATHS_FILE}"

# Count non-marker entries — if only the marker survived filtering,
# the agent's actual files are missing (install likely failed).
AGENT_PATHS=$(grep -cv "^${MARKER_FILE}$" "${FILTERED_FILE}" || true)
if [ "${AGENT_PATHS}" -eq 0 ]; then
  echo "Error: no agent files found for ${AGENT_NAME} (install may have failed)" >&2
  exit 1
fi

# Create tarball (paths are absolute, extract with tar xz -C /)
TARBALL="/tmp/spawn-agent-${AGENT_NAME}.tar.gz"
tar czf "${TARBALL}" -C / -T "${FILTERED_FILE}"

SIZE=$(du -h "${TARBALL}" | cut -f1)
echo "==> Created ${TARBALL} (${SIZE})"
