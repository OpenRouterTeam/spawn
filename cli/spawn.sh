#!/bin/bash
# spawn — Dynamic entry point for the Spawn matrix
#
# Launch any AI coding agent on any cloud, pre-configured with OpenRouter.
# Fetches the manifest dynamically from GitHub so it's always up-to-date.
#
# Usage:
#   spawn                       Interactive agent + cloud picker
#   spawn <agent> <cloud>       Launch agent on cloud directly
#   spawn <agent>               Show available clouds for agent
#   spawn list                  Full matrix table
#   spawn agents                List all agents with descriptions
#   spawn clouds                List all cloud providers
#   spawn improve [--loop]      Run improvement system
#   spawn update                Self-update from GitHub
#   spawn version               Show version
#   spawn help                  Show this help

set -eo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────

SPAWN_VERSION="0.1.0"
SPAWN_REPO="OpenRouterTeam/spawn"
SPAWN_RAW_BASE="https://raw.githubusercontent.com/${SPAWN_REPO}/main"
SPAWN_CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/spawn"
SPAWN_MANIFEST="${SPAWN_CACHE_DIR}/manifest.json"
SPAWN_CACHE_TTL=3600  # 1 hour in seconds

# ── Colors & Logging ──────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[spawn]${NC} $1" >&2; }
log_warn()  { echo -e "${YELLOW}[spawn]${NC} $1" >&2; }
log_error() { echo -e "${RED}[spawn]${NC} $1" >&2; }

# ── Dependency Checks ─────────────────────────────────────────────────────────

HAS_JQ=false
HAS_PYTHON3=false

check_deps() {
    if ! command -v curl &>/dev/null; then
        log_error "curl is required but not found"
        exit 1
    fi
    command -v jq &>/dev/null && HAS_JQ=true
    command -v python3 &>/dev/null && HAS_PYTHON3=true
    if ! ${HAS_JQ} && ! ${HAS_PYTHON3}; then
        log_error "Either jq or python3 is required for JSON parsing"
        exit 1
    fi
}

# ── JSON Helpers ───────────────────────────────────────────────────────────────

# Each helper tries jq first, falls back to python3.

json_validate() {
    local file="$1"
    if ${HAS_JQ}; then
        jq empty "${file}" 2>/dev/null
    elif ${HAS_PYTHON3}; then
        python3 -c "import json; json.load(open('${file}'))" 2>/dev/null
    fi
}

# List agent keys (one per line)
manifest_agents() {
    if ${HAS_JQ}; then
        jq -r '.agents | keys[]' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
for k in m['agents']:
    print(k)
"
    fi
}

# List cloud keys (one per line)
manifest_clouds() {
    if ${HAS_JQ}; then
        jq -r '.clouds | keys[]' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
for k in m['clouds']:
    print(k)
"
    fi
}

# Get agent display name
manifest_agent_name() {
    local agent="$1"
    if ${HAS_JQ}; then
        jq -r --arg a "${agent}" '.agents[${a}].name // empty' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
a = m['agents'].get('${agent}', {})
print(a.get('name', ''))
"
    fi
}

# Get agent description
manifest_agent_desc() {
    local agent="$1"
    if ${HAS_JQ}; then
        jq -r --arg a "${agent}" '.agents[${a}].description // empty' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
a = m['agents'].get('${agent}', {})
print(a.get('description', ''))
"
    fi
}

# Get cloud display name
manifest_cloud_name() {
    local cloud="$1"
    if ${HAS_JQ}; then
        jq -r --arg c "${cloud}" '.clouds[${c}].name // empty' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
c = m['clouds'].get('${cloud}', {})
print(c.get('name', ''))
"
    fi
}

# Get cloud description
manifest_cloud_desc() {
    local cloud="$1"
    if ${HAS_JQ}; then
        jq -r --arg c "${cloud}" '.clouds[${c}].description // empty' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
c = m['clouds'].get('${cloud}', {})
print(c.get('description', ''))
"
    fi
}

# Get matrix status for cloud/agent
manifest_matrix_status() {
    local cloud="$1" agent="$2"
    if ${HAS_JQ}; then
        jq -r --arg key "${cloud}/${agent}" '.matrix[${key}] // "missing"' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
print(m.get('matrix', {}).get('${cloud}/${agent}', 'missing'))
"
    fi
}

# Count implemented entries
manifest_count_implemented() {
    if ${HAS_JQ}; then
        jq '[.matrix | to_entries[] | select(.value == "implemented")] | length' "${SPAWN_MANIFEST}"
    else
        python3 -c "
import json
m = json.load(open('${SPAWN_MANIFEST}'))
print(sum(1 for v in m.get('matrix', {}).values() if v == 'implemented'))
"
    fi
}

# ── Manifest Cache ─────────────────────────────────────────────────────────────

file_age_seconds() {
    local file="$1"
    local now
    now=$(date +%s)
    local mtime
    # macOS uses -f, Linux uses -c
    if stat -f %m "${file}" &>/dev/null; then
        mtime=$(stat -f %m "${file}")
    else
        mtime=$(stat -c %Y "${file}" 2>/dev/null || echo 0)
    fi
    echo $(( now - mtime ))
}

ensure_manifest() {
    mkdir -p "${SPAWN_CACHE_DIR}"

    # Check if cache exists and is fresh
    if [[ -f "${SPAWN_MANIFEST}" ]]; then
        local age
        age=$(file_age_seconds "${SPAWN_MANIFEST}")
        if (( age < SPAWN_CACHE_TTL )); then
            return 0
        fi
    fi

    log_info "Fetching manifest..."
    local tmp
    tmp=$(mktemp)
    if curl -fsSL "${SPAWN_RAW_BASE}/manifest.json" -o "${tmp}" 2>/dev/null; then
        if json_validate "${tmp}"; then
            mv "${tmp}" "${SPAWN_MANIFEST}"
            return 0
        else
            rm -f "${tmp}"
            log_warn "Downloaded manifest is invalid JSON"
        fi
    else
        rm -f "${tmp}"
        log_warn "Failed to fetch manifest"
    fi

    # Offline fallback: use stale cache if available
    if [[ -f "${SPAWN_MANIFEST}" ]]; then
        log_warn "Using cached manifest (offline fallback)"
        return 0
    fi

    log_error "No manifest available. Check your internet connection."
    exit 1
}

# ── Interactive Picker ─────────────────────────────────────────────────────────

picker() {
    local prompt="$1"
    shift
    local -a items=("$@")
    local count=${#items[@]}

    echo "" >&2
    echo -e "${BOLD}${prompt}${NC}" >&2
    echo "" >&2

    local i
    for (( i = 0; i < count; i++ )); do
        printf "  %s%2d)%s %s\n" "${GREEN}" $(( i + 1 )) "${NC}" "${items[${i}]}" >&2
    done

    echo "" >&2
    local choice
    while true; do
        printf "  Enter number (1-%d): " "${count}" >&2
        read -r choice </dev/tty
        if [[ "${choice}" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= count )); then
            echo $(( choice - 1 ))
            return 0
        fi
        log_warn "Invalid choice. Enter a number between 1 and ${count}."
    done
}

# ── Commands ───────────────────────────────────────────────────────────────────

cmd_interactive() {
    ensure_manifest

    # Build agent list with descriptions
    local -a agent_keys=()
    local -a agent_labels=()
    while IFS= read -r key; do
        agent_keys+=("${key}")
        local name desc
        name=$(manifest_agent_name "${key}")
        desc=$(manifest_agent_desc "${key}")
        agent_labels+=("${name} ${DIM}- ${desc}${NC}")
    done < <(manifest_agents)

    if (( ${#agent_keys[@]} == 0 )); then
        log_error "No agents found in manifest"
        exit 1
    fi

    local agent_idx
    agent_idx=$(picker "Select an agent:" "${agent_labels[@]}")
    local agent="${agent_keys[${agent_idx}]}"

    # Build cloud list — only show implemented clouds for this agent
    local -a cloud_keys=()
    local -a cloud_labels=()
    while IFS= read -r key; do
        local status
        status=$(manifest_matrix_status "${key}" "${agent}")
        if [[ "${status}" == "implemented" ]]; then
            cloud_keys+=("${key}")
            local name desc
            name=$(manifest_cloud_name "${key}")
            desc=$(manifest_cloud_desc "${key}")
            cloud_labels+=("${name} ${DIM}- ${desc}${NC}")
        fi
    done < <(manifest_clouds)

    if (( ${#cloud_keys[@]} == 0 )); then
        local aname
        aname=$(manifest_agent_name "${agent}")
        log_error "No implemented clouds found for ${aname}"
        exit 1
    fi

    local cloud_idx
    cloud_idx=$(picker "Select a cloud provider:" "${cloud_labels[@]}")
    local cloud="${cloud_keys[${cloud_idx}]}"

    cmd_run "${agent}" "${cloud}"
}

cmd_run() {
    local agent="$1" cloud="$2"
    ensure_manifest

    local agent_name cloud_name status
    agent_name=$(manifest_agent_name "${agent}")
    cloud_name=$(manifest_cloud_name "${cloud}")

    if [[ -z "${agent_name}" ]]; then
        log_error "Unknown agent: ${agent}"
        echo "Run 'spawn agents' to see available agents." >&2
        exit 1
    fi
    if [[ -z "${cloud_name}" ]]; then
        log_error "Unknown cloud: ${cloud}"
        echo "Run 'spawn clouds' to see available clouds." >&2
        exit 1
    fi

    status=$(manifest_matrix_status "${cloud}" "${agent}")
    if [[ "${status}" != "implemented" ]]; then
        log_error "${agent_name} on ${cloud_name} is not yet implemented"
        exit 1
    fi

    log_info "Launching ${BOLD}${agent_name}${NC}${GREEN} on ${BOLD}${cloud_name}${NC}${GREEN}...${NC}"
    local url="https://openrouter.ai/lab/spawn/${cloud}/${agent}.sh"
    bash <(curl -fsSL "${url}")
}

cmd_list() {
    ensure_manifest

    if ${HAS_PYTHON3}; then
        cmd_list_python
    elif ${HAS_JQ}; then
        cmd_list_jq
    fi
}

cmd_list_jq() {
    jq -r '
        def pad(${n}): . + (" " * (${n} - length)) | .[:${n}];
        def status_icon: if . == "implemented" then "  ✓" else "  -" end;

        . as ${root} |
        (${root}.agents | keys) as ${agents} |
        (${root}.clouds | keys) as ${clouds} |

        (("" | pad(18)) + (${clouds} | map(. as ${c} | ${root}.clouds[${c}].name | pad(14)) | join(""))),
        (${agents}[] as ${agent} |
            (${root}.agents[${agent}].name | pad(18)) +
            (${clouds} | map(. as ${cloud} |
                (${root}.matrix["\(${cloud})/\(${agent})"] // "missing" | status_icon | pad(14))
            ) | join(""))
        ),
        "",
        ([${root}.matrix | to_entries[] | select(.value == "implemented")] | length | tostring) +
        "/" +
        ((${agents} | length) * (${clouds} | length) | tostring) +
        " implemented"
    ' "${SPAWN_MANIFEST}"
}

cmd_list_python() {
    python3 -c "
import json

m = json.load(open('${SPAWN_MANIFEST}'))
agents = list(m['agents'].keys())
clouds = list(m['clouds'].keys())
matrix = m.get('matrix', {})

G = '\033[0;32m'
R = '\033[0;31m'
D = '\033[2m'
B = '\033[1m'
NC = '\033[0m'

# Header
header = f'{\"\":18s}'
for c in clouds:
    header += f'{m[\"clouds\"][c][\"name\"]:14s}'
print(B + header + NC)

# Rows
for a in agents:
    row = f'{m[\"agents\"][a][\"name\"]:18s}'
    for c in clouds:
        key = f'{c}/{a}'
        status = matrix.get(key, 'missing')
        if status == 'implemented':
            row += G + f'{\"  ✓\":14s}' + NC
        else:
            row += D + f'{\"  -\":14s}' + NC
    print(row)

# Summary
impl = sum(1 for v in matrix.values() if v == 'implemented')
total = len(agents) * len(clouds)
print(f'\n{impl}/{total} implemented')
"
}

cmd_agents() {
    ensure_manifest

    echo ""
    echo -e "${BOLD}Agents${NC}"
    echo ""

    while IFS= read -r key; do
        local name desc
        name=$(manifest_agent_name "${key}")
        desc=$(manifest_agent_desc "${key}")
        printf "  ${GREEN}%-16s${NC} %s\n" "${name}" "${desc}"
    done < <(manifest_agents)
    echo ""
}

cmd_clouds() {
    ensure_manifest

    echo ""
    echo -e "${BOLD}Cloud Providers${NC}"
    echo ""

    while IFS= read -r key; do
        local name desc
        name=$(manifest_cloud_name "${key}")
        desc=$(manifest_cloud_desc "${key}")
        printf "  ${GREEN}%-16s${NC} %s\n" "${name}" "${desc}"
    done < <(manifest_clouds)
    echo ""
}

cmd_agent_info() {
    local agent="$1"
    ensure_manifest

    local agent_name agent_desc
    agent_name=$(manifest_agent_name "${agent}")
    agent_desc=$(manifest_agent_desc "${agent}")

    if [[ -z "${agent_name}" ]]; then
        log_error "Unknown agent: ${agent}"
        echo "Run 'spawn agents' to see available agents." >&2
        exit 1
    fi

    echo ""
    echo -e "${BOLD}${agent_name}${NC} — ${agent_desc}"
    echo ""
    echo -e "${BOLD}Available clouds:${NC}"
    echo ""

    local found=false
    while IFS= read -r cloud; do
        local status
        status=$(manifest_matrix_status "${cloud}" "${agent}")
        if [[ "${status}" == "implemented" ]]; then
            local cloud_name
            cloud_name=$(manifest_cloud_name "${cloud}")
            printf "  ${GREEN}%-16s${NC} spawn %s %s\n" "${cloud_name}" "${agent}" "${cloud}"
            found=true
        fi
    done < <(manifest_clouds)

    if ! ${found}; then
        echo "  No implemented clouds yet."
    fi
    echo ""
}

cmd_improve() {
    shift  # remove 'improve' from args
    local repo_dir

    # Check if we're already in the spawn repo
    if [[ -f "./improve.sh" && -f "./manifest.json" ]]; then
        repo_dir="."
    else
        repo_dir="${SPAWN_CACHE_DIR}/repo"
        if [[ -d "${repo_dir}/.git" ]]; then
            log_info "Updating spawn repo..."
            git -C "${repo_dir}" pull --ff-only 2>/dev/null || true
        else
            log_info "Cloning spawn repo..."
            git clone "https://github.com/${SPAWN_REPO}.git" "${repo_dir}"
        fi
    fi

    (cd "${repo_dir}" && bash improve.sh "$@")
}

cmd_update() {
    local self
    self=$(command -v spawn 2>/dev/null || echo "")
    if [[ -z "${self}" ]]; then
        # Try common install locations
        if [[ -f "${HOME}/.local/bin/spawn" ]]; then
            self="${HOME}/.local/bin/spawn"
        else
            log_error "Cannot find spawn binary for self-update"
            exit 1
        fi
    fi

    log_info "Checking for updates..."
    local tmp
    tmp=$(mktemp)
    if curl -fsSL "${SPAWN_RAW_BASE}/cli/spawn.sh" -o "${tmp}" 2>/dev/null; then
        local remote_version
        remote_version=$(grep '^SPAWN_VERSION=' "${tmp}" | head -1 | cut -d'"' -f2)
        if [[ -z "${remote_version}" ]]; then
            rm -f "${tmp}"
            log_error "Could not determine remote version"
            exit 1
        fi

        if [[ "${remote_version}" == "${SPAWN_VERSION}" ]]; then
            rm -f "${tmp}"
            log_info "Already up to date (v${SPAWN_VERSION})"
            return 0
        fi

        chmod +x "${tmp}"
        mv "${tmp}" "${self}"
        log_info "Updated: v${SPAWN_VERSION} → v${remote_version}"

        # Invalidate manifest cache on update
        rm -f "${SPAWN_MANIFEST}"
    else
        rm -f "${tmp}"
        log_error "Failed to download update"
        exit 1
    fi
}

cmd_help() {
    echo -e "
${BOLD}spawn${NC} — Launch any AI coding agent on any cloud

${BOLD}USAGE${NC}
  spawn                       Interactive agent + cloud picker
  spawn <agent> <cloud>       Launch agent on cloud directly
  spawn <agent>               Show available clouds for agent
  spawn list                  Full matrix table
  spawn agents                List all agents with descriptions
  spawn clouds                List all cloud providers
  spawn improve [--loop]      Run improvement system (wraps improve.sh)
  spawn update                Self-update from GitHub
  spawn version               Show version
  spawn help                  Show this help

${BOLD}EXAMPLES${NC}
  spawn                       Pick interactively
  spawn claude sprite         Launch Claude Code on Sprite
  spawn aider hetzner         Launch Aider on Hetzner Cloud
  spawn claude                Show which clouds support Claude Code
  spawn list                  See the full agent x cloud matrix

${BOLD}INSTALL${NC}
  curl -fsSL ${SPAWN_RAW_BASE}/cli/install.sh | bash
"
}

# ── Main ───────────────────────────────────────────────────────────────────────

main() {
    check_deps

    if (( $# == 0 )); then
        cmd_interactive
        return
    fi

    case "$1" in
        help|--help|-h)
            cmd_help
            ;;
        version|--version|-v|-V)
            echo "spawn v${SPAWN_VERSION}"
            ;;
        list|ls)
            cmd_list
            ;;
        agents)
            cmd_agents
            ;;
        clouds)
            cmd_clouds
            ;;
        improve)
            cmd_improve "$@"
            ;;
        update)
            cmd_update
            ;;
        *)
            # Could be: spawn <agent> or spawn <agent> <cloud>
            local agent="$1"
            ensure_manifest

            # Check if it's a valid agent
            local agent_name
            agent_name=$(manifest_agent_name "${agent}")
            if [[ -z "${agent_name}" ]]; then
                log_error "Unknown command or agent: ${agent}"
                echo "Run 'spawn help' for usage." >&2
                exit 1
            fi

            if (( $# >= 2 )); then
                cmd_run "${agent}" "$2"
            else
                cmd_agent_info "${agent}"
            fi
            ;;
    esac
}

main "$@"
