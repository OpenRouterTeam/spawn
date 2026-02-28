#!/bin/bash
# sh/e2e/aws-e2e.sh — Backwards-compatible wrapper for AWS E2E tests
#
# Usage:
#   ./sh/e2e/aws-e2e.sh                       # All agents, sequential
#   ./sh/e2e/aws-e2e.sh claude                # Single agent
#   ./sh/e2e/aws-e2e.sh claude codex opencode # Specific agents
#   ./sh/e2e/aws-e2e.sh --parallel 2          # Parallel (2 at a time)
#   ./sh/e2e/aws-e2e.sh --skip-cleanup        # Skip stale instance cleanup
#   ./sh/e2e/aws-e2e.sh --skip-input-test     # Skip live input tests
#
# This is a thin wrapper that delegates to the unified e2e.sh orchestrator.
set -eo pipefail

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e.sh" --cloud aws "$@"
