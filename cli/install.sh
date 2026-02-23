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

# --- Helper: check if sudo can authenticate without a password prompt ---
# Returns 0 if sudo is passwordless (root, NOPASSWD, or macOS Touch ID).
has_passwordless_sudo() {
    # Already root — no sudo needed
    [ "$(id -u)" = "0" ] && return 0
    # Check if sudo works non-interactively (NOPASSWD or cached credentials)
    sudo -n true 2>/dev/null && return 0
    # macOS: check if Touch ID is configured for sudo (pam_tid.so)
    if [ -f /etc/pam.d/sudo_local ] && grep -q "pam_tid" /etc/pam.d/sudo_local 2>/dev/null; then
        return 0
    fi
    if [ -f /etc/pam.d/sudo ] && grep -q "pam_tid" /etc/pam.d/sudo 2>/dev/null; then
        return 0
    fi
    return 1
}

# --- Helper: ensure spawn works immediately and in future sessions ---
# Installs to ~/.local/bin. If that's not already in PATH, also symlinks
# to /usr/local/bin for immediate availability (without prompting for a
# password — only if writable or passwordless sudo is available).
# Also patches shell rc files so both ~/.local/bin and ~/.bun/bin are in
# PATH for future sessions (bun is required by spawn's shebang).
ensure_in_path() {
    local install_dir="$1"
    local bun_bin_dir="${BUN_INSTALL}/bin"

    # 1. Check if install_dir and bun are already in the user's real PATH
    local spawn_in_path=false
    local bun_in_path=false
    if echo "${_SPAWN_ORIG_PATH}" | tr ':' '\n' | grep -qx "${install_dir}"; then
        spawn_in_path=true
    fi
    if echo "${_SPAWN_ORIG_PATH}" | tr ':' '\n' | grep -qx "${bun_bin_dir}"; then
        bun_in_path=true
    fi

    # 2. If spawn not in PATH, symlink into /usr/local/bin for immediate availability
    #    Try in order: direct write → passwordless sudo → prompt for password
    #    Also symlink bun so that spawn's #!/usr/bin/env bun shebang resolves
    local linked=false
    local bun_path
    bun_path="$(command -v bun 2>/dev/null || true)"
    if [ "$spawn_in_path" = false ]; then
        if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
            ln -sf "${install_dir}/spawn" /usr/local/bin/spawn && linked=true
            if [ -n "$bun_path" ] && [ ! -x /usr/local/bin/bun ]; then
                ln -sf "$bun_path" /usr/local/bin/bun 2>/dev/null || true
            fi
        elif has_passwordless_sudo; then
            sudo ln -sf "${install_dir}/spawn" /usr/local/bin/spawn 2>/dev/null && linked=true
            if [ -n "$bun_path" ] && [ ! -x /usr/local/bin/bun ]; then
                sudo ln -sf "$bun_path" /usr/local/bin/bun 2>/dev/null || true
            fi
        elif command -v sudo &>/dev/null; then
            # Last resort: ask for password
            log_step "Adding spawn to /usr/local/bin (may require your password)..."
            sudo ln -sf "${install_dir}/spawn" /usr/local/bin/spawn && linked=true || true
            if [ "$linked" = true ] && [ -n "$bun_path" ] && [ ! -x /usr/local/bin/bun ]; then
                sudo ln -sf "$bun_path" /usr/local/bin/bun 2>/dev/null || true
            fi
        fi
    fi

    # 3. Patch shell rc files so both ~/.local/bin and ~/.bun/bin are in PATH
    #    for future sessions. ~/.bun/bin is required by spawn's #!/usr/bin/env bun shebang.
    local rc_file=""
    case "${SHELL:-/bin/bash}" in
        */zsh)  rc_file="${HOME}/.zshrc" ;;
        */fish) rc_file="" ;;
        *)      rc_file="${HOME}/.bashrc" ;;
    esac

    # Helper: add a dir to rc files if not already present
    _patch_rc() {
        local dir="$1"
        local line="export PATH=\"${dir}:\$PATH\""
        if [ -n "$rc_file" ]; then
            if ! grep -qF "${dir}" "$rc_file" 2>/dev/null; then
                printf '\n# Added by spawn installer\n%s\n' "$line" >> "$rc_file"
            fi
            case "${SHELL:-/bin/bash}" in */bash)
                for profile in "${HOME}/.profile" "${HOME}/.bash_profile"; do
                    if [ -f "$profile" ] && ! grep -qF "${dir}" "$profile" 2>/dev/null; then
                        printf '\n# Added by spawn installer\n%s\n' "$line" >> "$profile"
                    fi
                done
            ;; esac
        else
            case "${SHELL:-}" in */fish)
                fish -c "fish_add_path \"${dir}\"" 2>/dev/null || true
            ;; esac
        fi
    }

    if [ "$spawn_in_path" = false ]; then
        _patch_rc "${install_dir}"
    fi
    if [ "$bun_in_path" = false ]; then
        _patch_rc "${bun_bin_dir}"
    fi

    # 4. Show version and success message
    echo ""
    SPAWN_NO_UPDATE_CHECK=1 PATH="${install_dir}:${PATH}" "${install_dir}/spawn" version
    echo ""
    local all_ready=true
    if [ "$spawn_in_path" = false ] && [ "$linked" = false ]; then
        all_ready=false
    fi
    if [ "$bun_in_path" = false ] && [ ! -x /usr/local/bin/bun ]; then
        all_ready=false
    fi
    if [ "$all_ready" = true ]; then
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
        # SECURITY: Reject non-ASCII characters (Unicode lookalikes/homoglyphs)
        if [[ "$f" =~ [^[:ascii:]] ]]; then
            log_error "Security: Non-ASCII characters in filename: $f"
            log_error "Only ASCII filenames are allowed."
            log_error "Installation aborted for safety."
            exit 1
        fi

        # SECURITY: Strict allowlist — only alphanumeric, underscore, hyphen, .ts extension
        if [[ ! "$f" =~ ^[a-zA-Z0-9_-]+\.ts$ ]]; then
            log_error "Security: Invalid filename from API: $f"
            log_error "Only alphanumeric .ts filenames are allowed."
            log_error "Installation aborted for safety."
            exit 1
        fi

        curl -fsSL "${SPAWN_RAW_BASE}/cli/src/${f}" -o "${dest}/cli/src/${f}"
    done
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
# Save original PATH before modifications so ensure_in_path() can check
# whether the install dir is already in the user's real PATH.
_SPAWN_ORIG_PATH="${PATH}"
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
