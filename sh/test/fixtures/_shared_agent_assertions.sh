#!/bin/bash
# Shared per-agent install assertions
# Verifies each agent script uses the correct install method
#
# Sourced by mock.sh _run_agent_assertions(). Expects:
#   MOCK_LOG  — path to the mock call log
#   PASSED / FAILED — counters (updated in-place)
#   GREEN / RED / NC — color codes

# Internal: assert a grep pattern appears in MOCK_LOG
_assert_install_pattern() {
    local pattern="$1"
    local msg="$2"
    if grep -qE "${pattern}" "${MOCK_LOG}" 2>/dev/null; then
        printf '%b\n' "    ${GREEN}✓${NC} ${msg}"
        PASSED=$((PASSED + 1))
    else
        printf '%b\n' "    ${RED}✗${NC} ${msg}"
        FAILED=$((FAILED + 1))
    fi
}

assert_agent_install() {
    local cloud="$1"
    local agent="$2"

    case "$agent" in
        claude)
            # install_claude_code finalization always runs "claude install --force"
            # (mock claude binary is pre-installed, so curl installer is skipped)
            _assert_install_pattern "claude.*install" "installs claude code" ;;
        openclaw)
            # bun install -g openclaw (npm works but bun is preferred due to issues on VPSs with npm)
            _assert_install_pattern "bun.*install.*openclaw" "installs openclaw via bun" ;;
        codex)
            # npm install -g @openai/codex
            _assert_install_pattern "npm.*install.*codex" "installs codex via npm" ;;
        opencode)
            # curl to download opencode tarball (via opencode_install_cmd)
            _assert_install_pattern "opencode" "installs opencode" ;;
        kilocode)
            # npm install -g @kilocode/cli
            _assert_install_pattern "npm.*install.*kilocode" "installs kilocode via npm" ;;
        zeroclaw)
            # curl installer from zeroclaw-labs/zeroclaw repo
            _assert_install_pattern "zeroclaw" "installs zeroclaw" ;;
        *)
            # Unknown agent — skip assertion (no failure)
            return 0 ;;
    esac
}
