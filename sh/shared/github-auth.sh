#!/bin/bash
# Standalone GitHub auth helper — installs gh CLI and runs OAuth login
# Executable directly via curl|bash; also sourceable using the CDN URL with eval.
#
# Usage (via curl|bash — recommended):
#   curl -fsSL --proto '=https' https://openrouter.ai/labs/spawn/shared/github-auth.sh | bash
#   curl -fsSL --proto '=https' https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/sh/shared/github-auth.sh | bash
#
# Usage (sourced using absolute path or CDN URL):
#   eval "$(curl -fsSL --proto '=https' https://openrouter.ai/labs/spawn/shared/github-auth.sh)"
#   ensure_github_auth

# ============================================================
# Logging helpers
# ============================================================

log_info()  { printf '[github-auth] %s\n' "$*" >&2; }
log_error() { printf '[github-auth] ERROR: %s\n' "$*" >&2; }

# ============================================================
# ensure_gh_cli — Install gh CLI if not already present
# ============================================================

# Install gh via Homebrew (macOS)
_install_gh_brew() {
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
}

# Install gh via APT with GitHub's official repository (Debian/Ubuntu)
_install_gh_apt() {
    # Use sudo only when not already root (some cloud containers run as root)
    local SUDO=""
    if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi

    log_info "Adding GitHub CLI APT repository..."
    curl -fsSL --proto '=https' https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | ${SUDO} dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    ${SUDO} chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    printf 'deb [arch=%s signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
        "$(dpkg --print-architecture)" \
        | ${SUDO} tee /etc/apt/sources.list.d/github-cli.list > /dev/null
    ${SUDO} apt-get update -qq
    DEBIAN_FRONTEND=noninteractive ${SUDO} apt-get install -y --no-install-recommends gh || {
        log_error "Failed to install gh via apt"
        return 1
    }
}

# Install gh via DNF (Fedora/RHEL)
_install_gh_dnf() {
    local SUDO=""
    if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi
    ${SUDO} dnf install -y gh || {
        log_error "Failed to install gh via dnf"
        return 1
    }
}

ensure_gh_cli() {
    if command -v gh &>/dev/null; then
        log_info "GitHub CLI (gh) available: $(gh --version | head -1)"
        return 0
    fi

    log_info "Installing GitHub CLI (gh)..."

    if [[ "$OSTYPE" == "darwin"* ]]; then
        _install_gh_brew || return 1
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get &>/dev/null; then
            _install_gh_apt || return 1
        elif command -v dnf &>/dev/null; then
            _install_gh_dnf || return 1
        else
            _install_gh_binary || return 1
        fi
    else
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

# Detect OS and architecture for binary downloads, outputting "os arch" on stdout.
# Returns 1 with error message if platform is unsupported.
_detect_gh_platform() {
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

    echo "${gh_os} ${gh_arch}"
}

# Fetch the latest gh release version string from GitHub API
_fetch_gh_latest_version() {
    local api_response
    api_response=$(curl -fsSL --proto '=https' "https://api.github.com/repos/cli/cli/releases/latest") || {
        log_error "Failed to fetch latest gh release version"
        return 1
    }

    local latest_version=""
    # Prefer jq for safe JSON parsing; fall back to bun eval (never python)
    if command -v jq &>/dev/null; then
        latest_version=$(printf '%s' "${api_response}" | jq -r '.tag_name // empty' 2>/dev/null) || true
    elif command -v bun &>/dev/null; then
        latest_version=$(_GH_API_RESPONSE="${api_response}" bun eval "
            const data = JSON.parse(process.env._GH_API_RESPONSE || '{}');
            const tag = typeof data.tag_name === 'string' ? data.tag_name : '';
            process.stdout.write(tag);
        " 2>/dev/null) || true
    else
        log_error "Neither jq nor bun available for safe JSON parsing"
        return 1
    fi

    # Strip leading 'v' prefix if present (tag_name is e.g. "v2.62.0")
    latest_version="${latest_version#v}"

    if [[ -z "${latest_version}" ]]; then
        log_error "Could not determine latest gh version"
        return 1
    fi

    # Validate version looks like a semver (digits and dots only)
    if [[ ! "${latest_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        log_error "Unexpected version format: ${latest_version}"
        return 1
    fi

    echo "${latest_version}"
}

# Download and extract a gh release tarball into ~/.local/bin
# Usage: _download_and_install_gh VERSION GH_OS GH_ARCH
_download_and_install_gh() {
    local version="${1}" gh_os="${2}" gh_arch="${3}"

    log_info "Downloading gh v${version} for ${gh_os}/${gh_arch}..."

    local tarball="gh_${version}_${gh_os}_${gh_arch}.tar.gz"
    local url="https://github.com/cli/cli/releases/download/v${version}/${tarball}"
    local tmpdir
    tmpdir=$(mktemp -d)

    curl -fsSL --proto '=https' "${url}" -o "${tmpdir}/${tarball}" || {
        log_error "Failed to download ${url}"
        rm -rf "${tmpdir}"
        return 1
    }

    # Verify SHA256 checksum before extracting (CWE-494: integrity check)
    local checksums_url="https://github.com/cli/cli/releases/download/v${version}/gh_${version}_checksums.txt"
    local checksums_file="${tmpdir}/gh_${version}_checksums.txt"
    curl -fsSL --proto '=https' "${checksums_url}" -o "${checksums_file}" || {
        log_error "Failed to download checksums from ${checksums_url}"
        rm -rf "${tmpdir}"
        return 1
    }

    # Use sha256sum on Linux, shasum -a 256 on macOS
    local sha_cmd=""
    if command -v sha256sum &>/dev/null; then
        sha_cmd="sha256sum"
    elif command -v shasum &>/dev/null; then
        sha_cmd="shasum -a 256"
    else
        log_error "No SHA256 tool available (need sha256sum or shasum)"
        rm -rf "${tmpdir}"
        return 1
    fi

    # Extract expected checksum for our tarball from the checksums file
    local expected_checksum
    expected_checksum=$(grep "  ${tarball}"'$' "${checksums_file}" | awk '{print $1}')
    if [[ -z "${expected_checksum}" ]]; then
        log_error "Checksum for ${tarball} not found in checksums.txt"
        rm -rf "${tmpdir}"
        return 1
    fi

    # Compute actual checksum of downloaded file
    local actual_checksum
    actual_checksum=$(cd "${tmpdir}" && ${sha_cmd} "${tarball}" | awk '{print $1}')
    if [[ "${actual_checksum}" != "${expected_checksum}" ]]; then
        log_error "SHA256 checksum mismatch for ${tarball}"
        log_error "  expected: ${expected_checksum}"
        log_error "  actual:   ${actual_checksum}"
        rm -rf "${tmpdir}"
        return 1
    fi

    log_info "SHA256 checksum verified for ${tarball}"

    # Defense-in-depth: reject tarballs containing absolute paths or ../ traversal
    # (CWE-22: path traversal). This check is cross-platform (GNU + BSD tar).
    if tar -tzf "${tmpdir}/${tarball}" | grep -qE '(^/|\.\.)'; then
        log_error "Tarball contains absolute paths or path traversal — refusing to extract"
        rm -rf "${tmpdir}"
        return 1
    fi

    tar -xzf "${tmpdir}/${tarball}" -C "${tmpdir}" || {
        log_error "Failed to extract ${tarball}"
        rm -rf "${tmpdir}"
        return 1
    }

    mkdir -p "${HOME}/.local/bin"
    cp "${tmpdir}/gh_${version}_${gh_os}_${gh_arch}/bin/gh" "${HOME}/.local/bin/gh"
    chmod +x "${HOME}/.local/bin/gh"
    rm -rf "${tmpdir}"

    # Add ~/.local/bin to PATH if not already there
    case ":${PATH}:" in
        *":${HOME}/.local/bin:"*) ;;
        *) export PATH="${HOME}/.local/bin:${PATH}" ;;
    esac

    log_info "gh installed to ${HOME}/.local/bin/gh"
}

_install_gh_binary() {
    log_info "Installing gh from GitHub releases (binary fallback)..."

    local platform
    platform=$(_detect_gh_platform) || return 1
    local gh_os gh_arch
    read -r gh_os gh_arch <<< "${platform}"

    local latest_version
    latest_version=$(_fetch_gh_latest_version) || return 1

    _download_and_install_gh "${latest_version}" "${gh_os}" "${gh_arch}"
}

# ============================================================
# ensure_gh_auth — Authenticate with GitHub via gh auth login
# ============================================================

ensure_gh_auth() {
    # When GITHUB_TOKEN is set, persist it to gh's credential store so it
    # survives into the interactive session (where the env var is absent).
    # NOTE: This writes the token to ~/.config/gh/hosts.yml in plaintext,
    # which is standard gh CLI behavior (same as `gh auth login`).
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        # Validate token format: must start with a known GitHub prefix
        case "${GITHUB_TOKEN}" in
            ghp_*|gho_*|ghu_*|ghs_*|ghr_*|github_pat_*)
                ;;
            *)
                log_error "GITHUB_TOKEN has unexpected format (expected ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_ prefix)"
                return 1
                ;;
        esac
        # SECURITY: Reject tokens containing newlines, tabs, or carriage returns
        # to prevent credential file corruption and bypass of downstream validation.
        if [[ "${GITHUB_TOKEN}" =~ $'\n' ]] || [[ "${GITHUB_TOKEN}" =~ $'\t' ]] || [[ "${GITHUB_TOKEN}" =~ $'\r' ]]; then
            log_error "GITHUB_TOKEN contains invalid control characters (newline/tab/CR)"
            return 1
        fi

        # Fast path: skip persistence if gh is already authenticated with
        # stored credentials (not just the env var). Temporarily unset
        # GITHUB_TOKEN so gh auth status checks disk credentials only.
        local _gh_token="${GITHUB_TOKEN}"
        unset GITHUB_TOKEN
        if gh auth status &>/dev/null; then
            export GITHUB_TOKEN="${_gh_token}"
            log_info "Authenticated with GitHub CLI (credentials already persisted)"
            return 0
        fi

        log_info "Persisting GITHUB_TOKEN to gh credential store..."
        # GITHUB_TOKEN is already unset above so gh auth login won't refuse
        # with "The value of the GITHUB_TOKEN environment variable is being
        # used for authentication."
        printf '%s\n' "${_gh_token}" | gh auth login --with-token || {
            log_error "Failed to authenticate with GITHUB_TOKEN"
            export GITHUB_TOKEN="${_gh_token}"
            return 1
        }
        # Restrict token file permissions to owner-only (prevents exposure on multi-user systems)
        chmod 600 "${HOME}/.config/gh/hosts.yml" 2>/dev/null || true
        export GITHUB_TOKEN="${_gh_token}"
    elif gh auth status &>/dev/null; then
        log_info "Authenticated with GitHub CLI"
        return 0
    else
        # Device code flow — works on headless/remote servers
        # Shows a URL + code; user opens URL in local browser and enters the code
        log_info "Authenticating via device code flow..."
        log_info "A URL and code will appear below. Open the URL in your browser and enter the code."
        gh auth login --web -p https -h github.com || {
            log_error "GitHub authentication failed"
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
# When piped via curl|bash, BASH_SOURCE[0] is empty and $0 is "bash"
if [[ "${BASH_SOURCE[0]}" == "${0}" ]] || [[ -z "${BASH_SOURCE[0]:-}" ]]; then
    set -eo pipefail
    ensure_github_auth
fi
