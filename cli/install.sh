#!/bin/bash
# Installer for the spawn CLI
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
#
# Override install directory:
#   SPAWN_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash

set -euo pipefail

SPAWN_REPO="OpenRouterTeam/spawn"
SPAWN_RAW_BASE="https://raw.githubusercontent.com/$SPAWN_REPO/main"
INSTALL_DIR="${SPAWN_INSTALL_DIR:-$HOME/.local/bin}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[spawn]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[spawn]${NC} $1"; }
log_error() { echo -e "${RED}[spawn]${NC} $1"; }

# Check curl
if ! command -v curl &>/dev/null; then
    log_error "curl is required but not found"
    exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download spawn CLI
log_info "Downloading spawn CLI..."
if ! curl -fsSL "$SPAWN_RAW_BASE/cli/spawn.sh" -o "$INSTALL_DIR/spawn"; then
    log_error "Failed to download spawn CLI"
    exit 1
fi

chmod +x "$INSTALL_DIR/spawn"
log_info "Installed spawn to $INSTALL_DIR/spawn"

# Check if install dir is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    log_warn "$INSTALL_DIR is not in your PATH"
    echo ""
    echo "Add it by running one of:"
    echo ""

    # Detect shell and suggest appropriate config
    case "${SHELL:-/bin/bash}" in
        */zsh)
            echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
            ;;
        */fish)
            echo "  fish_add_path $INSTALL_DIR"
            ;;
        *)
            echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
            ;;
    esac
    echo ""
else
    log_info "Run 'spawn' to get started"
fi
