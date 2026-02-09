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

# --- Method 1: bun install -g (preferred) ---
if command -v bun &>/dev/null; then
    log_info "Installing spawn via bun..."
    # Clone/download the cli directory and install from it
    tmpdir=$(mktemp -d)
    trap 'rm -rf "${tmpdir}"' EXIT

    log_info "Downloading CLI package..."
    mkdir -p "${tmpdir}/cli/src"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/package.json"    -o "${tmpdir}/cli/package.json"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/tsconfig.json"    -o "${tmpdir}/cli/tsconfig.json"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/index.ts"     -o "${tmpdir}/cli/src/index.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/manifest.ts"  -o "${tmpdir}/cli/src/manifest.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/commands.ts"   -o "${tmpdir}/cli/src/commands.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/version.ts"    -o "${tmpdir}/cli/src/version.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/security.ts"   -o "${tmpdir}/cli/src/security.ts"

    cd "${tmpdir}/cli"
    bun install
    bun run build
    bun link 2>/dev/null || bun install -g . 2>/dev/null || {
        # If global install fails, build and copy binary
        log_warn "Global install failed, building binary..."
        bun build src/index.ts --compile --outfile spawn
        INSTALL_DIR="${SPAWN_INSTALL_DIR:-${HOME}/.local/bin}"
        mkdir -p "${INSTALL_DIR}"
        mv spawn "${INSTALL_DIR}/spawn"
        log_info "Installed spawn binary to ${INSTALL_DIR}/spawn"
    }

    log_info "spawn installed successfully!"
    echo ""
    if command -v spawn &>/dev/null; then
        spawn version
        echo ""
        log_info "Run ${BOLD}spawn${NC}${GREEN} to get started${NC}"
    fi
    exit 0
fi

# --- Method 2: npm install -g ---
if command -v npm &>/dev/null && command -v node &>/dev/null; then
    log_info "Installing spawn via npm..."
    tmpdir=$(mktemp -d)
    trap 'rm -rf "${tmpdir}"' EXIT

    log_info "Downloading CLI package..."
    mkdir -p "${tmpdir}/cli/src"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/package.json"    -o "${tmpdir}/cli/package.json"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/tsconfig.json"    -o "${tmpdir}/cli/tsconfig.json"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/index.ts"     -o "${tmpdir}/cli/src/index.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/manifest.ts"  -o "${tmpdir}/cli/src/manifest.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/commands.ts"   -o "${tmpdir}/cli/src/commands.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/version.ts"    -o "${tmpdir}/cli/src/version.ts"
    curl -fsSL "${SPAWN_RAW_BASE}/cli/src/security.ts"   -o "${tmpdir}/cli/src/security.ts"

    cd "${tmpdir}/cli"
    npm install

    # Build cli.js — package.json bin points to it, so it must exist before linking
    log_info "Building CLI..."
    npx -y esbuild src/index.ts --bundle --outfile=cli.js --platform=node --format=esm --banner:js='#!/usr/bin/env node' 2>/dev/null || {
        log_error "Failed to build cli.js. Install bun instead (recommended):"
        echo "  curl -fsSL https://bun.sh/install | bash"
        echo "  Then re-run: curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
        exit 1
    }
    chmod +x cli.js

    npm install -g . 2>/dev/null || {
        log_warn "npm global install requires elevated permissions."
        echo ""
        echo "Choose one of these options:"
        echo ""
        echo "  1. Install with sudo (recommended):"
        echo "     cd ${tmpdir}/cli && sudo npm install -g ."
        echo ""
        echo "  2. Install bun instead (no sudo needed):"
        echo "     curl -fsSL https://bun.sh/install | bash"
        echo "     Then re-run: curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
        echo ""
        echo "  3. Use the bash fallback (limited functionality):"
        echo "     SPAWN_INSTALL_DIR=~/.local/bin curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
        echo ""
        exit 1
    }

    log_info "spawn installed successfully!"
    echo ""
    if command -v spawn &>/dev/null; then
        spawn version
        echo ""
        log_info "Run ${BOLD}spawn${NC}${GREEN} to get started${NC}"
    fi
    exit 0
fi

# --- Method 3: Direct download fallback (bash wrapper) ---
log_warn "Neither bun nor npm found. Installing bash fallback..."

INSTALL_DIR="${SPAWN_INSTALL_DIR:-${HOME}/.local/bin}"
mkdir -p "${INSTALL_DIR}"

if ! curl -fsSL "${SPAWN_RAW_BASE}/cli/spawn.sh" -o "${INSTALL_DIR}/spawn"; then
    log_error "Failed to download spawn CLI"
    exit 1
fi

chmod +x "${INSTALL_DIR}/spawn"
log_info "Installed spawn (bash) to ${INSTALL_DIR}/spawn"

# Check if install dir is in PATH
if ! echo "${PATH}" | tr ':' '\n' | grep -qx "${INSTALL_DIR}"; then
    log_warn "${INSTALL_DIR} is not in your PATH"
    echo ""
    echo "Add it to your PATH to use spawn from anywhere:"
    echo ""
    case "${SHELL:-/bin/bash}" in
        */zsh)
            echo "  echo 'export PATH=\"${INSTALL_DIR}:\${PATH}\"' >> ~/.zshrc"
            echo "  source ~/.zshrc"
            ;;
        */fish)
            echo "  fish_add_path ${INSTALL_DIR}"
            ;;
        *)
            echo "  echo 'export PATH=\"${INSTALL_DIR}:\${PATH}\"' >> ~/.bashrc"
            echo "  source ~/.bashrc"
            ;;
    esac
    echo ""
    echo "Or run directly: ${INSTALL_DIR}/spawn"
    echo ""
else
    log_info "Installation complete!"
    echo ""
    echo "Try these commands:"
    echo "  ${BOLD}spawn${NC}           - Interactive mode"
    echo "  ${BOLD}spawn --help${NC}    - Show all commands"
    echo "  ${BOLD}spawn list${NC}      - View the full matrix"
    echo ""
fi
