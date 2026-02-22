#!/bin/bash
# Installer for the spawn CLI
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/cli/install.sh | bash
#
# This installs spawn via bun. If bun is not available, it auto-installs it first.
#
# Override install directory:
#   SPAWN_INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash

set -eo pipefail

SPAWN_REPO="OpenRouterTeam/spawn"
SPAWN_RAW_BASE="https://raw.githubusercontent.com/${SPAWN_REPO}/main"
MIN_BUN_VERSION="1.2.0"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

CYAN='\033[0;36m'

log_info()  { printf "${GREEN}[spawn]${NC} %s\n" "$1"; }
log_step()  { printf "${CYAN}[spawn]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[spawn]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[spawn]${NC} %s\n" "$1"; }

# --- Helper: compare semver strings ---
# Returns 0 (true) if $1 >= $2
version_gte() {
    local IFS='.'
    local a=($1) b=($2)
    local i=0
    while [ $i -lt ${#b[@]} ]; do
        local av="${a[$i]:-0}"
        local bv="${b[$i]:-0}"
        if [ "$av" -lt "$bv" ]; then
            return 1
        elif [ "$av" -gt "$bv" ]; then
            return 0
        fi
        i=$((i + 1))
    done
    return 0
}

# --- Helper: ensure bun meets minimum version ---
ensure_min_bun_version() {
    local current
    current="$(bun --version)"
    if ! version_gte "$current" "$MIN_BUN_VERSION"; then
        log_warn "bun ${current} is below minimum ${MIN_BUN_VERSION}, upgrading..."
        bun upgrade
        current="$(bun --version)"
        if ! version_gte "$current" "$MIN_BUN_VERSION"; then
            log_error "Failed to upgrade bun to >= ${MIN_BUN_VERSION} (got ${current})"
            echo ""
            echo "Please upgrade bun manually:"
            echo "  bun upgrade"
            echo ""
            echo "Then re-run:"
            echo "  curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
            exit 1
        fi
        log_info "bun upgraded to ${current}"
    fi
}

# --- Helper: ensure spawn works immediately and in future sessions ---
# Always installs to ~/.local/bin AND symlinks to /usr/local/bin.
# Also patches shell rc files so ~/.local/bin is in PATH for future sessions.
ensure_in_path() {
    local install_dir="$1"

    # 1. Symlink into /usr/local/bin so it works RIGHT NOW (always in PATH)
    local linked=false
    if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
        ln -sf "${install_dir}/spawn" /usr/local/bin/spawn && linked=true
    fi
    if [ "$linked" = false ] && command -v sudo &>/dev/null; then
        sudo ln -sf "${install_dir}/spawn" /usr/local/bin/spawn 2>/dev/null && linked=true
    fi

    # 2. Patch shell rc files so ~/.local/bin is in PATH for future sessions
    local export_line="export PATH=\"${install_dir}:\$PATH\""
    local rc_file=""
    case "${SHELL:-/bin/bash}" in
        */zsh)  rc_file="${HOME}/.zshrc" ;;
        */fish) rc_file="" ;;
        *)      rc_file="${HOME}/.bashrc" ;;
    esac

    if [ -n "$rc_file" ]; then
        if ! grep -qF "${install_dir}" "$rc_file" 2>/dev/null; then
            printf '\n# Added by spawn installer\n%s\n' "$export_line" >> "$rc_file"
        fi
        # Also patch .profile/.bash_profile for login shells
        case "${SHELL:-/bin/bash}" in */bash)
            for profile in "${HOME}/.profile" "${HOME}/.bash_profile"; do
                if [ -f "$profile" ] && ! grep -qF "${install_dir}" "$profile" 2>/dev/null; then
                    printf '\n# Added by spawn installer\n%s\n' "$export_line" >> "$profile"
                fi
            done
        ;; esac
    else
        case "${SHELL:-}" in */fish)
            fish -c "fish_add_path ${install_dir}" 2>/dev/null || true
        ;; esac
    fi

    # 3. Show version and success message
    echo ""
    SPAWN_NO_UPDATE_CHECK=1 PATH="${install_dir}:${PATH}" "${install_dir}/spawn" version
    echo ""
    if [ "$linked" = true ]; then
        printf "${GREEN}[spawn]${NC} Run ${BOLD}spawn${NC} to get started\n"
    else
        printf "${GREEN}[spawn]${NC} To start using spawn, run:\n"
        echo ""
        echo "    exec \$SHELL"
        echo ""
    fi
}

clone_cli() {
    local dest="$1"
    if command -v git &>/dev/null; then
        log_step "Cloning CLI source..."
        git clone --depth 1 --filter=blob:none --sparse \
            "https://github.com/${SPAWN_REPO}.git" "${dest}/repo" 2>/dev/null
        cd "${dest}/repo"
        git sparse-checkout set cli 2>/dev/null
        mv cli "${dest}/cli"
        cd "${dest}"
        # Safety check: only delete if path is canonically within dest directory
        local repo_dir="${dest}/repo"
        if [[ -d "${repo_dir}" ]]; then
            local canonical_repo
            canonical_repo=$(cd "${repo_dir}" 2>/dev/null && pwd) || true
            local canonical_dest
            canonical_dest=$(cd "${dest}" 2>/dev/null && pwd) || true

            if [[ -n "${canonical_repo}" ]] && [[ -n "${canonical_dest}" ]] && [[ "${canonical_repo}" == "${canonical_dest}/repo" ]]; then
                rm -rf "${repo_dir}"
            else
                log_warn "Skipping cleanup: path validation failed"
            fi
        fi
    else
        log_step "Downloading CLI source..."
        mkdir -p "${dest}/cli/src"
        # Download all source files via GitHub API
        local files
        files=$(curl -fsSL "https://api.github.com/repos/${SPAWN_REPO}/contents/cli/src" \
            | grep '"name"' | grep '\.ts"' | grep -v '__tests__' \
            | sed 's/.*"name": "//;s/".*//')
        curl -fsSL "${SPAWN_RAW_BASE}/cli/package.json"  -o "${dest}/cli/package.json"
        curl -fsSL "${SPAWN_RAW_BASE}/cli/bun.lock"       -o "${dest}/cli/bun.lock"
        curl -fsSL "${SPAWN_RAW_BASE}/cli/tsconfig.json"  -o "${dest}/cli/tsconfig.json"
        for f in $files; do
            # SECURITY: Validate filename to prevent path traversal attacks
            # Block parent directory references (..) and directory separators (/)
            if [[ "$f" =~ \.\. ]] || [[ "$f" =~ / ]] || [[ "$f" =~ \\ ]]; then
                log_error "Security: Invalid filename from API (path traversal attempt): $f"
                log_error "This may indicate a compromised network connection or API response."
                log_error "Installation aborted for safety."
                exit 1
            fi

            # Filename is safe - proceed with download
            curl -fsSL "${SPAWN_RAW_BASE}/cli/src/${f}" -o "${dest}/cli/src/${f}"
        done
    fi
}

# --- Helper: build and install the CLI using bun ---
build_and_install() {
    tmpdir=$(mktemp -d)
    trap 'rm -rf "${tmpdir}"' EXIT

    clone_cli "${tmpdir}"

    cd "${tmpdir}/cli"
    bun install

    if ! bun run build 2>/dev/null; then
        log_warn "Local build failed, downloading pre-built binary..."
        curl -fsSL "https://github.com/${SPAWN_REPO}/releases/download/cli-latest/cli.js" -o cli.js
        if [ ! -s cli.js ]; then
            log_error "Failed to download pre-built binary"
            exit 1
        fi
    fi

    INSTALL_DIR="${SPAWN_INSTALL_DIR:-${HOME}/.local/bin}"
    mkdir -p "${INSTALL_DIR}"
    cp cli.js "${INSTALL_DIR}/spawn"
    chmod +x "${INSTALL_DIR}/spawn"

    log_info "Installed spawn to ${INSTALL_DIR}/spawn"
    ensure_in_path "${INSTALL_DIR}"
}

# --- Locate or install bun ---
# When running via `curl | bash`, subshells may not inherit PATH updates,
# so we always prepend the standard bun install locations explicitly.
export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
export PATH="${BUN_INSTALL}/bin:${HOME}/.local/bin:${PATH}"

if ! command -v bun &>/dev/null; then
    log_step "bun not found. Installing bun..."
    curl -fsSL https://bun.sh/install | bash

    # Re-export so bun is available in this session immediately
    export PATH="${BUN_INSTALL}/bin:${PATH}"

    if ! command -v bun &>/dev/null; then
        log_error "Failed to install bun automatically"
        echo ""
        echo "Please install bun manually:"
        echo "  curl -fsSL https://bun.sh/install | bash"
        echo ""
        echo "Then reopen your terminal and re-run:"
        echo "  curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash"
        exit 1
    fi

    log_info "bun installed successfully"
fi

ensure_min_bun_version

log_step "Installing spawn via bun..."
build_and_install
