#!/bin/bash
set -eo pipefail

# sprite-keep-running — Wraps a command and keeps the sprite alive by pinging
# its own public URL every 30 seconds. Prevents inactivity shutdown while an
# agent session is running.
#
# Usage: sprite-keep-running <command> [args...]
#
# The keep-alive loop runs in the background and is killed when the wrapped
# command exits. Exit code is preserved from the wrapped command.

if [ $# -eq 0 ]; then
    echo "Usage: sprite-keep-running <command> [args...]" >&2
    exit 1
fi

# Resolve sprite's own public URL via sprite-env (available on all sprites)
SPRITE_URL=""
if command -v sprite-env >/dev/null 2>&1; then
    SPRITE_URL=$(sprite-env info 2>/dev/null | grep -o '"sprite_url":"[^"]*"' | cut -d'"' -f4) || true
fi

if [ -z "${SPRITE_URL}" ]; then
    # Can't determine URL — just run the command without keep-alive
    exec "$@"
fi

# Start background keep-alive loop
(
    while true; do
        curl -sf "${SPRITE_URL}" >/dev/null 2>&1 || true
        sleep 30
    done
) &
KEEPALIVE_PID=$!

# Ensure keep-alive is killed on exit
cleanup() {
    kill "${KEEPALIVE_PID}" 2>/dev/null || true
    wait "${KEEPALIVE_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Run the wrapped command
"$@"
