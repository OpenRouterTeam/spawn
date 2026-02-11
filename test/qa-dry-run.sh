#!/bin/bash
set -eo pipefail

# Local dry run of the QA cycle — no git push, no PRs, no Claude agents.
# Tests the full Phase 1→5 pipeline with mock data.
#
# Usage:
#   bash test/qa-dry-run.sh              # Full run (all clouds)
#   bash test/qa-dry-run.sh --inject-fail hetzner/claude   # Inject a fake failure

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

RESULTS_1="/tmp/qa-dry-results-1.txt"
RESULTS_2="/tmp/qa-dry-results-2.txt"
INJECT_FAIL=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --inject-fail) INJECT_FAIL="$2"; shift 2 ;;
        *) printf '%b\n' "${RED}Unknown arg: $1${NC}"; exit 1 ;;
    esac
done

cleanup() {
    rm -f "${RESULTS_1}" "${RESULTS_2}"
}
trap cleanup EXIT

printf '%b\n' "${CYAN}========================================${NC}"
printf '%b\n' "${CYAN} QA Cycle Dry Run (local, no side effects)${NC}"
printf '%b\n' "${CYAN}========================================${NC}"
printf '\n'

# ── Phase 1: Record fixtures (skip in dry run — use existing) ──
printf '%b\n' "${CYAN}Phase 1: Record fixtures${NC}"
printf '%b\n' "  ${YELLOW}skip${NC} Using existing fixtures (dry run)"
printf '\n'

# ── Phase 2: Run mock tests ──
printf '%b\n' "${CYAN}Phase 2: Run mock tests${NC}"
rm -f "${RESULTS_1}"
RESULTS_FILE="${RESULTS_1}" bash test/mock.sh 2>&1 || true

if [[ -n "${INJECT_FAIL}" ]]; then
    printf '%b\n' "\n  ${YELLOW}Injecting fake failure:${NC} ${INJECT_FAIL}"
    # Replace pass with fail for the injected combo
    if grep -q "^${INJECT_FAIL}:" "${RESULTS_1}" 2>/dev/null; then
        sed -i.bak "s|^${INJECT_FAIL}:pass$|${INJECT_FAIL}:fail|" "${RESULTS_1}"
        rm -f "${RESULTS_1}.bak"
    else
        printf '%s:fail\n' "${INJECT_FAIL}" >> "${RESULTS_1}"
    fi
fi

PASS_1=$(grep -c ':pass$' "${RESULTS_1}" 2>/dev/null || echo 0)
FAIL_1=$(grep -c ':fail$' "${RESULTS_1}" 2>/dev/null || echo 0)
TOTAL_1=$(wc -l < "${RESULTS_1}" | tr -d ' ')
printf '\n%b\n' "  ${GREEN}${PASS_1} pass${NC} / ${RED}${FAIL_1} fail${NC} / ${TOTAL_1} total"
printf '\n'

# ── Phase 3: Update README (dry run — show diff, don't commit) ──
printf '%b\n' "${CYAN}Phase 3: Update README matrix${NC}"
# Save original
cp README.md /tmp/qa-dry-readme-backup.md

python3 test/update-readme.py "${RESULTS_1}"

if git diff --quiet README.md 2>/dev/null; then
    printf '%b\n' "  ${GREEN}No changes${NC}"
else
    printf '%b\n' "  ${YELLOW}Changes:${NC}"
    git diff --stat README.md
    git diff README.md | head -30
    # Revert
    cp /tmp/qa-dry-readme-backup.md README.md
    printf '%b\n' "  ${YELLOW}(reverted — dry run)${NC}"
fi
rm -f /tmp/qa-dry-readme-backup.md
printf '\n'

# ── Phase 4: Fix failures (dry run — just list what would be fixed) ──
printf '%b\n' "${CYAN}Phase 4: Fix failures${NC}"
if [[ "${FAIL_1}" -eq 0 ]]; then
    printf '%b\n' "  ${GREEN}No failures to fix${NC}"
else
    printf '%b\n' "  Would spawn agents for:"
    grep ':fail$' "${RESULTS_1}" | sed 's/:fail$//' | while read -r combo; do
        cloud=$(printf '%s' "$combo" | cut -d/ -f1)
        agent=$(printf '%s' "$combo" | cut -d/ -f2)
        printf '%b\n' "    ${RED}•${NC} ${cloud}/${agent}.sh → worktree /tmp/spawn-worktrees/qa/fix-${cloud}-${agent}/"
    done
    printf '%b\n' "  ${YELLOW}(skipped — dry run)${NC}"
fi
printf '\n'

# ── Phase 5: Re-run tests (same as phase 2 in dry run) ──
printf '%b\n' "${CYAN}Phase 5: Re-run tests${NC}"
rm -f "${RESULTS_2}"
RESULTS_FILE="${RESULTS_2}" bash test/mock.sh 2>&1 | tail -3 || true

PASS_2=$(grep -c ':pass$' "${RESULTS_2}" 2>/dev/null || echo 0)
FAIL_2=$(grep -c ':fail$' "${RESULTS_2}" 2>/dev/null || echo 0)
printf '\n%b\n' "  ${GREEN}${PASS_2} pass${NC} / ${RED}${FAIL_2} fail${NC}"
printf '\n'

# ── Summary ──
printf '%b\n' "${CYAN}========================================${NC}"
printf '%b\n' "${CYAN} Summary${NC}"
printf '%b\n' "${CYAN}========================================${NC}"
printf '%b\n' "  Phase 2: ${PASS_1} pass / ${FAIL_1} fail"
printf '%b\n' "  Phase 5: ${PASS_2} pass / ${FAIL_2} fail"
if [[ -n "${INJECT_FAIL}" ]]; then
    printf '%b\n' "  ${YELLOW}Note: --inject-fail was used, Phase 4 agents were skipped${NC}"
fi
printf '%b\n' "  ${GREEN}Dry run complete — no git operations performed${NC}"
