#!/bin/bash
# Standalone GitHub auth helper — installs gh CLI and runs OAuth login
# Sourceable by any agent script, or executable directly via curl|bash
#
# Usage (sourced):
#   source shared/github-auth.sh
#   ensure_github_auth
#
# Usage (direct):
#   bash shared/github-auth.sh
#   curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/github-auth.sh | bash

# ============================================================
# Source shared/common.sh for logging (local-or-remote fallback)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR:-}" && -f "${SCRIPT_DIR}/common.sh" ]]; then
    source "${SCRIPT_DIR}/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Fallback log functions if common.sh failed to load
if ! type log_info &>/dev/null 2>&1; then
    log_info()  { printf '[github-auth] %s\n' "$*" >&2; }
    log_step()  { printf '[github-auth] %s\n' "$*" >&2; }
    log_warn()  { printf '[github-auth] WARNING: %s\n' "$*" >&2; }
    log_error() { printf '[github-auth] ERROR: %s\n' "$*" >&2; }
fi

# ============================================================
# ensure_gh_cli — Install gh CLI if not already present
# ============================================================

ensure_gh_cli() {
    if command -v gh &>/dev/null; then
        log_info "GitHub CLI (gh) available: $(gh --version | head -1)"
        return 0
    fi

    log_step "Installing GitHub CLI (gh)..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS — require Homebrew
        if command -v brew &>/dev/null; then
            brew install gh || {
                log_error "Failed to install gh via Homebrew"
                return 1
            }
        else
            log_error "Homebrew not found. Install Homebrew first: https://brew.sh"
            log_error "Then run: brew install gh"
            return 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get &>/dev/null; then
            # Debian/Ubuntu — add GitHub's official APT repo
            log_step "Adding GitHub CLI APT repository..."
            curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
                | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
            sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
            printf 'deb [arch=%s signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
                "$(dpkg --print-architecture)" \
                | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
            sudo apt-get update -qq
            sudo apt-get install -y gh || {
                log_error "Failed to install gh via apt"
                return 1
            }
        elif command -v dnf &>/dev/null; then
            # Fedora/RHEL
            sudo dnf install -y gh || {
                log_error "Failed to install gh via dnf"
                return 1
            }
        else
            # Fallback — download prebuilt binary
            _install_gh_binary || return 1
        fi
    else
        # Unknown OS — try binary fallback
        _install_gh_binary || return 1
    fi

    if ! command -v gh &>/dev/null; then
        log_error "gh not found in PATH after installation"
        return 1
    fi

    log_info "GitHub CLI (gh) installed: $(gh --version | head -1)"
}

# ============================================================
# Binary fallback installer (non-apt/non-brew systems)
# ============================================================

_install_gh_binary() {
    log_step "Installing gh from GitHub releases (binary fallback)..."

    local os arch gh_os gh_arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "${os}" in
        Linux)  gh_os="linux" ;;
        Darwin) gh_os="macOS" ;;
        *)
            log_error "Unsupported OS: ${os}. Install manually from https://cli.github.com/"
            return 1
            ;;
    esac

    case "${arch}" in
        x86_64|amd64)  gh_arch="amd64" ;;
        aarch64|arm64) gh_arch="arm64" ;;
        *)
            log_error "Unsupported architecture: ${arch}. Install manually from https://cli.github.com/"
            return 1
            ;;
    esac

    # Get latest release version
    local latest_version
    latest_version=$(curl -fsSL "https://api.github.com/repos/cli/cli/releases/latest" \
        | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/') || {
        log_error "Failed to fetch latest gh release version"
        return 1
    }

    if [[ -z "${latest_version}" ]]; then
        log_error "Could not determine latest gh version"
        return 1
    fi

    log_step "Downloading gh v${latest_version} for ${gh_os}/${gh_arch}..."

    local tarball="gh_${latest_version}_${gh_os}_${gh_arch}.tar.gz"
    local url="https://github.com/cli/cli/releases/download/v${latest_version}/${tarball}"
    local tmpdir
    tmpdir=$(mktemp -d)

    curl -fsSL "${url}" -o "${tmpdir}/${tarball}" || {
        log_error "Failed to download ${url}"
        rm -rf "${tmpdir}"
        return 1
    }

    tar -xzf "${tmpdir}/${tarball}" -C "${tmpdir}" || {
        log_error "Failed to extract ${tarball}"
        rm -rf "${tmpdir}"
        return 1
    }

    # Install to ~/.local/bin
    mkdir -p "${HOME}/.local/bin"
    cp "${tmpdir}/gh_${latest_version}_${gh_os}_${gh_arch}/bin/gh" "${HOME}/.local/bin/gh"
    chmod +x "${HOME}/.local/bin/gh"
    rm -rf "${tmpdir}"

    # Add ~/.local/bin to PATH if not already there
    case ":${PATH}:" in
        *":${HOME}/.local/bin:"*) ;;
        *) export PATH="${HOME}/.local/bin:${PATH}" ;;
    esac

    log_info "gh installed to ${HOME}/.local/bin/gh"
}

# ============================================================
# ensure_gh_auth — Authenticate with GitHub via gh auth login
# ============================================================

ensure_gh_auth() {
    if gh auth status &>/dev/null; then
        log_info "Authenticated with GitHub CLI"
        return 0
    fi

    log_step "Not authenticated with GitHub CLI"

    # Non-interactive: use GITHUB_TOKEN if set
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        log_step "Authenticating with GITHUB_TOKEN..."
        printf '%s\n' "${GITHUB_TOKEN}" | gh auth login --with-token || {
            log_error "Failed to authenticate with GITHUB_TOKEN"
            return 1
        }
    else
        # Interactive: browser-based OAuth flow
        log_step "Initiating GitHub CLI authentication..."
        gh auth login || {
            log_error "Failed to authenticate with GitHub CLI"
            log_error "Run manually: gh auth login"
            return 1
        }
    fi

    if ! gh auth status &>/dev/null; then
        log_error "gh auth status check failed after login"
        return 1
    fi

    log_info "Authenticated with GitHub CLI"
    return 0
}

# ============================================================
# ensure_github_auth — Combined convenience wrapper
# ============================================================

ensure_github_auth() {
    ensure_gh_cli || return 1
    ensure_gh_auth || return 1
}

# ============================================================
# Direct execution support
# ============================================================

# If executed directly (not sourced), run ensure_github_auth
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    set -eo pipefail
    ensure_github_auth
fi
