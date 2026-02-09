#!/bin/bash
# Installer for the spawn CLI
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
#
# This installs spawn via bun (preferred) or npm. If neither is available,
# it falls back to downloading the bundled JS file and creating a runner script.
#
# Override install directory (for fallback method):
#   SPAWN_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash

set -eo pipefail

SPAWN_REPO="OpenRouterTeam/spawn"
SPAWN_RAW_BASE="https://raw.githubusercontent.com/${SPAWN_REPO}/main"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[spawn]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[spawn]${NC} $1"; }
log_error() { echo -e "${RED}[spawn]${NC} $1"; }

# --- Helper: clone the cli directory ---
# --- Helper: find the best install directory ---
# Picks the first directory that exists AND is in PATH
find_install_dir() {
    if [ -n "${SPAWN_INSTALL_DIR:-}" ]; then
        echo "${SPAWN_INSTALL_DIR}"
        return
    fi
    # Check common bin dirs in order of preference
    local dirs=(
        "${HOME}/.local/bin"
        "$(bun pm bin -g 2>/dev/null)"
        "${HOME}/.bun/bin"
        "${HOME}/bin"
    )
    for dir in "${dirs[@]}"; do
        [ -z "$dir" ] && continue
        if echo "${PATH}" | tr ':' '\n' | grep -qx "$dir"; then
            echo "$dir"
            return
        fi
    done
    # Nothing in PATH — default to ~/.local/bin and warn later
    echo "${HOME}/.local/bin"
}

# --- Helper: show PATH instructions if spawn isn't findable ---
ensure_in_path() {
    local install_dir="$1"
    if echo "${PATH}" | tr ':' '\n' | grep -qx "${install_dir}"; then
        echo ""
        "${install_dir}/spawn" version
        echo ""
        log_info "Run ${BOLD}spawn${NC}${GREEN} to get started${NC}"
    else
        echo ""
        log_warn "${BOLD}${install_dir}${NC}${YELLOW} is not in your PATH${NC}"
        echo ""
        case "${SHELL:-/bin/bash}" in
            */zsh)
                echo "  Run this, then reopen your terminal:"
                echo ""
                echo "    echo 'export PATH=\"${install_dir}:\$PATH\"' >> ~/.zshrc"
                ;;
            */fish)
                echo "  Run this, then reopen your terminal:"
                echo ""
                echo "    fish_add_path ${install_dir}"
                ;;
            *)
                echo "  Run this, then reopen your terminal:"
                echo ""
                echo "    echo 'export PATH=\"${install_dir}:\$PATH\"' >> ~/.bashrc"
                ;;
        esac
        echo ""
        echo "  Or run directly: ${install_dir}/spawn"
        echo ""
    fi
}

clone_cli() {
    local dest="$1"
    if command -v git &>/dev/null; then
        log_info "Cloning CLI source..."
        git clone --depth 1 --filter=blob:none --sparse \
            "https://github.com/${SPAWN_REPO}.git" "${dest}/repo" 2>/dev/null
        cd "${dest}/repo"
        git sparse-checkout set cli 2>/dev/null
        mv cli "${dest}/cli"
        cd "${dest}"
        rm -rf "${dest}/repo"
    else
        log_info "Downloading CLI source..."
        mkdir -p "${dest}/cli/src"
        # Download all source files via GitHub API
        local files
        files=$(curl -fsSL "https://api.github.com/repos/${SPAWN_REPO}/contents/cli/src" \
            | grep '"name"' | grep '\.ts"' | grep -v '__tests__' \
            | sed 's/.*"name": "//;s/".*//')
        curl -fsSL "${SPAWN_RAW_BASE}/cli/package.json"  -o "${dest}/cli/package.json"
        curl -fsSL "${SPAWN_RAW_BASE}/cli/tsconfig.json"  -o "${dest}/cli/tsconfig.json"
        for f in $files; do
            curl -fsSL "${SPAWN_RAW_BASE}/cli/src/${f}" -o "${dest}/cli/src/${f}"
        done
    fi
}

# --- Method 1: bun (preferred) ---
if command -v bun &>/dev/null; then
    log_info "Installing spawn via bun..."
    tmpdir=$(mktemp -d)
    trap 'rm -rf "${tmpdir}"' EXIT

    clone_cli "${tmpdir}"

    cd "${tmpdir}/cli"
    bun install
    bun run build

    INSTALL_DIR="$(find_install_dir)"
    mkdir -p "${INSTALL_DIR}"
    cp cli.js "${INSTALL_DIR}/spawn"
    chmod +x "${INSTALL_DIR}/spawn"
    log_info "Installed spawn to ${INSTALL_DIR}/spawn"
    ensure_in_path "${INSTALL_DIR}"
    exit 0
fi

# --- Method 2: npm/node ---
if command -v npm &>/dev/null && command -v node &>/dev/null; then
    log_info "Installing spawn via npm..."
    tmpdir=$(mktemp -d)
    trap 'rm -rf "${tmpdir}"' EXIT

    clone_cli "${tmpdir}"

    cd "${tmpdir}/cli"
    npm install

    # Build cli.js with node shebang
    log_info "Building CLI..."
    npx -y esbuild src/index.ts --bundle --outfile=cli.js --platform=node --format=esm --banner:js='#!/usr/bin/env node' 2>/dev/null || {
        log_error "Failed to build cli.js. Install bun instead (recommended):"
        echo "  curl -fsSL https://bun.sh/install | bash"
        echo "  Then re-run: curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
        exit 1
    }

    INSTALL_DIR="$(find_install_dir)"
    mkdir -p "${INSTALL_DIR}"
    cp cli.js "${INSTALL_DIR}/spawn"
    chmod +x "${INSTALL_DIR}/spawn"
    log_info "Installed spawn to ${INSTALL_DIR}/spawn"
    ensure_in_path "${INSTALL_DIR}"
    exit 0
fi

# --- Method 3: Direct download fallback (bash wrapper) ---
log_warn "Neither bun nor npm found. Installing bash fallback..."

INSTALL_DIR="$(find_install_dir)"
mkdir -p "${INSTALL_DIR}"

if ! curl -fsSL "${SPAWN_RAW_BASE}/cli/spawn.sh" -o "${INSTALL_DIR}/spawn"; then
    log_error "Failed to download spawn CLI"
    exit 1
fi

chmod +x "${INSTALL_DIR}/spawn"
log_info "Installed spawn (bash) to ${INSTALL_DIR}/spawn"
ensure_in_path "${INSTALL_DIR}"
