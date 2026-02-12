#!/bin/bash
export TRIGGER_SECRET="29521a52b6942933e84fe87f28ed08b909a4bfa61140ad2023af955d9a84aeb2"
export TARGET_SCRIPT="/home/sprite/spawn/.claude/skills/setup-trigger-service/refactor.sh"
export REPO_ROOT="/home/sprite/spawn"
export MAX_CONCURRENT=3          # 1 refactor + 2 issue runs simultaneously
export RUN_TIMEOUT_MS=14400000   # 4 hours (server-level safety net)
exec bun run /home/sprite/spawn/.claude/skills/setup-trigger-service/trigger-server.ts
