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
            # npm install -g openclaw OR bun install -g openclaw (varies by cloud)
            _assert_install_pattern "install.*openclaw" "installs openclaw via npm/bun" ;;
        nanoclaw)
            # git clone https://github.com/gavrielc/nanoclaw.git && npm install
            _assert_install_pattern "git.*clone.*nanoclaw" "installs nanoclaw via git clone" ;;
        aider)
            # uv tool install --python 3.12 --upgrade aider-chat
            _assert_install_pattern "uv.*tool.*install.*aider" "installs aider via uv" ;;
        goose)
            # curl -fsSL https://github.com/block/goose/releases/.../download_cli.sh | bash
            _assert_install_pattern "goose.*download_cli" "installs goose via curl installer" ;;
        codex)
            # npm install -g @openai/codex
            _assert_install_pattern "npm.*install.*codex" "installs codex via npm" ;;
        interpreter)
            # uv tool install open-interpreter --python 3.12
            _assert_install_pattern "uv.*tool.*install.*open-interpreter" "installs interpreter via uv" ;;
        gemini)
            # npm install -g @google/gemini-cli
            _assert_install_pattern "npm.*install.*gemini-cli" "installs gemini via npm" ;;
        amazonq)
            # curl -fsSL https://...amazonaws.com/.../amazon-q-cli-install.sh | bash
            _assert_install_pattern "amazon-q.*install" "installs amazonq via curl installer" ;;
        cline)
            # npm install -g cline
            _assert_install_pattern "npm.*install.*cline" "installs cline via npm" ;;
        gptme)
            # uv tool install gptme
            _assert_install_pattern "uv.*tool.*install.*gptme" "installs gptme via uv" ;;
        opencode)
            # curl to download opencode tarball (via opencode_install_cmd)
            _assert_install_pattern "opencode" "installs opencode" ;;
        plandex)
            # curl -sL https://plandex.ai/install.sh | bash
            _assert_install_pattern "plandex.ai/install" "installs plandex via curl installer" ;;
        kilocode)
            # npm install -g @kilocode/cli
            _assert_install_pattern "npm.*install.*kilocode" "installs kilocode via npm" ;;
        continue)
            # npm install -g @continuedev/cli
            _assert_install_pattern "npm.*install.*continuedev" "installs continue via npm" ;;
        *)
            # Unknown agent — skip assertion (no failure)
            return 0 ;;
    esac
}
