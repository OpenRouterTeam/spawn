#!/bin/bash
# Common bash functions for AWS Lightsail spawn scripts
# Uses AWS CLI when available; falls back to direct SigV4-signed REST API calls (via Bun)

# Bash safety flags
set -eo pipefail

# ============================================================
# Provider-agnostic functions
# ============================================================

# Source shared provider-agnostic functions (local or remote fallback)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../../shared/common.sh" ]]; then
    source "${SCRIPT_DIR}/../../shared/common.sh"
else
    eval "$(curl -fsSL https://raw.githubusercontent.com/OpenRouterTeam/spawn/main/shared/common.sh)"
fi

# Note: Provider-agnostic functions (logging, OAuth, browser, nc_listen) are now in shared/common.sh

# ============================================================
# AWS Lightsail specific functions
# ============================================================

SPAWN_DASHBOARD_URL="https://lightsail.aws.amazon.com/"
# SSH_OPTS is now defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}  # Delay between instance status checks

# LIGHTSAIL_MODE is set by ensure_aws_cli: "cli" or "rest"
LIGHTSAIL_MODE="${LIGHTSAIL_MODE:-}"

# ============================================================
# Lightsail REST API helpers (Bun/TypeScript — used when AWS CLI is unavailable)
# ============================================================

# Parse a JSON field from stdin using a simple dot-path, e.g. ".instance.state.name"
# Prefers jq; falls back to bun eval.
# Usage: echo '{"a":{"b":"val"}}' | _ls_json ".a.b"
_ls_json() {
    local path="$1"
    if command -v jq &>/dev/null; then
        jq -r "${path} // empty"
    else
        local _ls_data
        _ls_data=$(cat)
        _JSON_INPUT="${_ls_data}" bun eval \
            "const path=process.argv[2];const d=JSON.parse(process.env._JSON_INPUT);const v=path.replace(/^\./,'').split('.').reduce((o,k)=>o?.[k],d);if(v!=null)process.stdout.write(String(v));" \
            "${path}" 2>/dev/null || true
    fi
}

# Make a SigV4-signed POST request to the Lightsail API.
# Delegates all crypto and HTTP to an inline Bun TypeScript script — no openssl gymnastics.
# Usage: _lightsail_rest "Lightsail_20161128.OperationName" '{"key":"val"}'
# Prints JSON response body on success; logs error and returns non-zero on failure.
_lightsail_rest() {
    local amz_target="$1"
    local body="${2:-\{\}}"

    if [[ -z "${AWS_ACCESS_KEY_ID:-}" ]] || [[ -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        log_error "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for REST API calls"
        return 1
    fi

    local tmp_ts tmp_out tmp_err
    tmp_ts=$(mktemp /tmp/spawn-ls-XXXXX.ts)
    tmp_out=$(mktemp)
    tmp_err=$(mktemp)

    cat > "${tmp_ts}" << 'TS_EOF'
import { createHash, createHmac } from "node:crypto";

const target = process.argv[2];
const body   = process.argv[3] ?? "{}";
const region = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const ak     = process.env.AWS_ACCESS_KEY_ID!;
const sk     = process.env.AWS_SECRET_ACCESS_KEY!;
const token  = process.env.AWS_SESSION_TOKEN ?? "";

const service = "lightsail";
const host    = `lightsail.${region}.amazonaws.com`;

// Timestamp: 20230101T120000Z
const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const amzDate   = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
const dateStamp = amzDate.slice(0, 8);

const sha256 = (s: string)                    => createHash("sha256").update(s).digest("hex");
const hmac   = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

const payloadHash = sha256(body);
const ct          = "application/x-amz-json-1.1";

// Headers sorted alphabetically — "host" required in signature, excluded from fetch call
const allHeaders: [string, string][] = [
    ["content-type",  ct],
    ["host",          host],
    ["x-amz-date",    amzDate],
    ...(token ? [["x-amz-security-token", token] as [string, string]] : []),
    ["x-amz-target",  target],
];

const canonicalHeaders = allHeaders.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
const signedHeaders    = allHeaders.map(([k]) => k).join(";");

// Canonical request: METHOD\nURI\nQUERY\nHEADERS\nSIGNED_HEADERS\nPAYLOAD_HASH
// canonicalHeaders already ends with \n; joining with \n adds the required blank line
const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
const stringToSign    = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;

const kDate    = hmac(`AWS4${sk}`, dateStamp);
const kRegion  = hmac(kDate,    region);
const kService = hmac(kRegion,  service);
const kSigning = hmac(kService, "aws4_request");
const sig      = hmac(kSigning, stringToSign).toString("hex");

const authHeader = `AWS4-HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

// Build fetch headers: exclude "host" (fetch sets it automatically)
const reqHeaders: Record<string, string> = Object.fromEntries(allHeaders.filter(([k]) => k !== "host"));
reqHeaders["Authorization"] = authHeader;

const resp = await fetch(`https://${host}/`, { method: "POST", headers: reqHeaders, body });
const text = await resp.text();
if (!resp.ok) {
    let msg = "";
    try { const e = JSON.parse(text); msg = e.message || e.Message || e.__type || ""; } catch {}
    process.stderr.write(`Lightsail API error (HTTP ${resp.status}) ${target}: ${msg || text}\n`);
    process.exit(1);
}
process.stdout.write(text);
TS_EOF

    local exit_code response err_out
    exit_code=0
    bun run "${tmp_ts}" "${amz_target}" "${body}" >"${tmp_out}" 2>"${tmp_err}" || exit_code=$?
    response=$(cat "${tmp_out}")
    err_out=$(cat "${tmp_err}")
    rm -f "${tmp_ts}" "${tmp_out}" "${tmp_err}"

    if [[ ${exit_code} -ne 0 ]]; then
        log_error "${err_out:-${response}}"
        return 1
    fi
    printf '%s' "${response}"
}

# ============================================================
# Authentication / mode detection
# ============================================================

# Install the AWS CLI v2.
# macOS: uses the official .pkg installer (requires sudo).
# Linux: downloads the zip installer (requires unzip + sudo).
# Returns 0 on success, 1 on failure.
_install_aws_cli() {
    log_step "Installing AWS CLI v2..."

    # Try brew first (works on macOS and Linux if Homebrew is installed)
    if command -v brew &>/dev/null; then
        log_info "Installing via Homebrew..."
        if brew install awscli; then
            log_info "AWS CLI v2 installed via Homebrew"
            return 0
        fi
        log_warn "Homebrew install failed, falling back to official installer..."
    fi

    if [[ "$(uname)" == "Darwin" ]]; then
        local _aws_tmp
        _aws_tmp=$(mktemp -d)
        curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "${_aws_tmp}/AWSCLIV2.pkg" \
            && sudo installer -pkg "${_aws_tmp}/AWSCLIV2.pkg" -target / \
            && rm -rf "${_aws_tmp}" \
            || {
                rm -rf "${_aws_tmp}"
                log_error "AWS CLI install failed."
                log_error "  Try manually: brew install awscli"
                return 1
            }
    else
        if ! command -v unzip &>/dev/null; then
            log_info "Installing unzip (required for AWS CLI)..."
            sudo DEBIAN_FRONTEND=noninteractive apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unzip || {
                log_error "Could not install unzip. Install it manually, then re-run."
                return 1
            }
        fi
        local _aws_tmp
        _aws_tmp=$(mktemp -d)
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" \
            -o "${_aws_tmp}/awscliv2.zip" \
            && unzip -q "${_aws_tmp}/awscliv2.zip" -d "${_aws_tmp}" \
            && sudo "${_aws_tmp}/aws/install" \
            && rm -rf "${_aws_tmp}" \
            || {
                rm -rf "${_aws_tmp}"
                log_error "AWS CLI install failed."
                log_error "  See: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
                return 1
            }
    fi
    log_info "AWS CLI v2 installed"
}

ensure_aws_cli() {
    local region="${AWS_DEFAULT_REGION:-${LIGHTSAIL_REGION:-us-east-1}}"

    # ── 1. Try existing CLI ───────────────────────────────────
    if command -v aws &>/dev/null; then
        if aws sts get-caller-identity &>/dev/null 2>&1; then
            LIGHTSAIL_MODE="cli"
            export AWS_DEFAULT_REGION="${region}"
            export LIGHTSAIL_MODE
            log_info "AWS CLI ready, using region: ${region}"
            return 0
        else
            log_warn "AWS CLI found but credentials invalid or expired"
        fi
    fi

    # ── 2. Fall back to REST if raw credentials are set ───────
    if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]] && [[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        if command -v bun &>/dev/null; then
            LIGHTSAIL_MODE="rest"
            export AWS_DEFAULT_REGION="${region}"
            export LIGHTSAIL_MODE
            log_info "AWS CLI not available — using Lightsail REST API directly (via Bun)"
            log_info "Using region: ${region}"
            return 0
        fi
        log_warn "Bun not found — cannot use REST API mode. Will try to install AWS CLI instead."
    fi

    # ── 3. Offer to install the AWS CLI ───────────────────────
    if ! command -v aws &>/dev/null; then
        log_warn "AWS CLI is not installed."
        local install_choice
        install_choice=$(safe_read "Install AWS CLI now? [Y/n] ") || install_choice="y"
        install_choice="${install_choice:-y}"

        case "${install_choice}" in
            [nN]*)
                log_info "Skipping AWS CLI install."
                ;;
            *)
                if _install_aws_cli; then
                    # Installed — now prompt for credentials
                    log_info "Run 'aws configure' to set your AWS credentials."
                    local access_key secret_key
                    access_key=$(safe_read "AWS Access Key ID: ") || return 1
                    secret_key=$(safe_read "AWS Secret Access Key: ") || return 1
                    export AWS_ACCESS_KEY_ID="${access_key}"
                    export AWS_SECRET_ACCESS_KEY="${secret_key}"
                    export AWS_DEFAULT_REGION="${region}"

                    if aws sts get-caller-identity &>/dev/null 2>&1; then
                        LIGHTSAIL_MODE="cli"
                        export LIGHTSAIL_MODE
                        log_info "AWS CLI configured, using region: ${region}"
                        return 0
                    else
                        log_warn "Credentials did not validate — falling through to REST mode"
                    fi
                fi
                ;;
        esac
    fi

    # ── 4. Last resort: REST mode with whatever creds we have ─
    if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]] && [[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
        if command -v bun &>/dev/null; then
            LIGHTSAIL_MODE="rest"
            export AWS_DEFAULT_REGION="${region}"
            export LIGHTSAIL_MODE
            log_info "Using Lightsail REST API directly (via Bun)"
            log_info "Using region: ${region}"
            return 0
        fi
    fi

    # ── 5. Nothing worked — show manual instructions ──────────
    _log_diagnostic \
        "AWS credentials not found" \
        "Could not configure AWS access via CLI or environment variables" \
        --- \
        "Option 1 — Install + configure the AWS CLI:" \
        "  brew install awscli  (macOS)" \
        "  or: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" \
        "  then: aws configure" \
        "Option 2 — Environment variables (no CLI needed, requires bun):" \
        "  export AWS_ACCESS_KEY_ID=AKIA..." \
        "  export AWS_SECRET_ACCESS_KEY=..."
    return 1
}

# ============================================================
# SSH key management
# ============================================================

ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"
    local pub_path="${key_path}.pub"

    # Generate key if needed
    generate_ssh_key_if_missing "${key_path}"

    # Validate SSH public key path before upload
    if [[ ! -f "${pub_path}" ]]; then
        log_error "SSH public key not found: ${pub_path}"
        return 1
    fi
    if [[ -L "${pub_path}" ]]; then
        log_error "SSH public key cannot be a symlink: ${pub_path}"
        return 1
    fi
    # SSH public keys are typically 100-600 bytes (ed25519/RSA)
    # Reject suspiciously large files to prevent arbitrary file upload
    local size
    size=$(wc -c <"${pub_path}")
    if [[ ${size} -gt 10000 ]]; then
        log_error "SSH public key file too large: ${size} bytes (max 10000)"
        return 1
    fi

    local key_name="spawn-key"

    if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
        # Check if already registered
        if aws lightsail get-key-pair --key-pair-name "${key_name}" &>/dev/null; then
            log_info "SSH key already registered with Lightsail"
            return 0
        fi

        log_step "Importing SSH key to Lightsail..."
        aws lightsail import-key-pair \
            --key-pair-name "${key_name}" \
            --public-key-base64 "$(cat "${pub_path}")" \
            >/dev/null 2>&1 || {
            # Race condition: another process may have imported it
            if aws lightsail get-key-pair --key-pair-name "${key_name}" &>/dev/null; then
                log_info "SSH key already registered with Lightsail"
                return 0
            fi
            log_error "Failed to import SSH key to Lightsail"
            return 1
        }
        log_info "SSH key imported to Lightsail"
    else
        # REST path
        if _lightsail_rest "Lightsail_20161128.GetKeyPair" \
                "{\"keyPairName\":\"${key_name}\"}" >/dev/null 2>&1; then
            log_info "SSH key already registered with Lightsail"
            return 0
        fi

        log_step "Importing SSH key to Lightsail via REST API..."
        # Build JSON body with bun so the key content is properly escaped
        local import_body
        import_body=$(bun eval \
            "const k=require('fs').readFileSync(process.argv[2],'utf8').trim();process.stdout.write(JSON.stringify({keyPairName:process.argv[3],publicKeyBase64:k}));" \
            "${pub_path}" "${key_name}")

        _lightsail_rest "Lightsail_20161128.ImportKeyPair" "${import_body}" >/dev/null || {
            # Race condition check
            if _lightsail_rest "Lightsail_20161128.GetKeyPair" \
                    "{\"keyPairName\":\"${key_name}\"}" >/dev/null 2>&1; then
                log_info "SSH key already registered with Lightsail"
                return 0
            fi
            log_error "Failed to import SSH key to Lightsail"
            return 1
        }
        log_info "SSH key imported to Lightsail"
    fi
}

get_server_name() {
    get_validated_server_name "LIGHTSAIL_SERVER_NAME" "Enter Lightsail instance name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends curl unzip git zsh nodejs npm ca-certificates
# Upgrade Node.js to v22 LTS (apt has v18, agents like Cline need v20+)
# n installs to /usr/local/bin but apt's v18 at /usr/bin can shadow it, so symlink over
npm install -g n && n 22 && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm && ln -sf /usr/local/bin/npx /usr/bin/npx
# Install Bun
su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash'
# Install Claude Code
su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash'
# Configure npm global prefix so ubuntu can npm install -g without sudo
su - ubuntu -c 'mkdir -p ~/.npm-global/bin && npm config set prefix ~/.npm-global'
# Configure PATH
echo 'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.bashrc
echo 'export PATH="${HOME}/.npm-global/bin:${HOME}/.claude/local/bin:${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.zshrc
chown ubuntu:ubuntu /home/ubuntu/.bashrc /home/ubuntu/.zshrc
touch /home/ubuntu/.cloud-init-complete
chown ubuntu:ubuntu /home/ubuntu/.cloud-init-complete
CLOUD_INIT_EOF
}

# Wait for Lightsail instance to become running and get its public IP
# Sets: LIGHTSAIL_SERVER_IP
# Usage: _wait_for_lightsail_instance NAME [MAX_ATTEMPTS]
_wait_for_lightsail_instance() {
    local name="${1}"
    local max_attempts=${2:-60}
    local attempt=1

    log_step "Waiting for instance to become running..."
    while [[ ${attempt} -le ${max_attempts} ]]; do
        local state resp ip

        if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
            state=$(aws lightsail get-instance --instance-name "${name}" \
                --query 'instance.state.name' --output text 2>/dev/null)
        else
            resp=$(_lightsail_rest "Lightsail_20161128.GetInstance" \
                "{\"instanceName\":\"${name}\"}" 2>/dev/null) || resp=""
            state=$(printf '%s' "${resp}" | _ls_json '.instance.state.name' 2>/dev/null || true)
        fi

        if [[ "${state}" == "running" ]]; then
            if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
                ip=$(aws lightsail get-instance --instance-name "${name}" \
                    --query 'instance.publicIpAddress' --output text)
            else
                ip=$(printf '%s' "${resp}" | _ls_json '.instance.publicIpAddress' 2>/dev/null || true)
            fi
            LIGHTSAIL_SERVER_IP="${ip}"
            export LIGHTSAIL_SERVER_IP
            log_info "Instance running: IP=${LIGHTSAIL_SERVER_IP}"
            return 0
        fi
        log_step "Instance state: ${state:-pending} (${attempt}/${max_attempts})"
        sleep "${INSTANCE_STATUS_POLL_DELAY}"
        attempt=$((attempt + 1))
    done

    log_error "Instance did not become running after ${max_attempts} checks"
    log_warn "The instance may still be provisioning. You can:"
    log_warn "  1. Re-run the command to try again"
    log_warn "  2. Check the Lightsail console: https://lightsail.aws.amazon.com/"
    return 1
}

create_server() {
    local name="${1}"
    local bundle="${LIGHTSAIL_BUNDLE:-medium_3_0}"
    local region="${AWS_DEFAULT_REGION:-us-east-1}"
    local az="${region}a"
    local blueprint="ubuntu_24_04"

    # Validate env var inputs to prevent command injection
    validate_resource_name "${bundle}" || { log_error "Invalid LIGHTSAIL_BUNDLE"; return 1; }
    validate_region_name "${region}" || { log_error "Invalid AWS_DEFAULT_REGION"; return 1; }

    log_step "Creating Lightsail instance '${name}' (bundle: ${bundle}, AZ: ${az})..."

    local userdata
    userdata=$(get_cloud_init_userdata)

    if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
        if ! aws lightsail create-instances \
            --instance-names "${name}" \
            --availability-zone "${az}" \
            --blueprint-id "${blueprint}" \
            --bundle-id "${bundle}" \
            --key-pair-name "spawn-key" \
            --user-data "${userdata}" \
            >/dev/null; then
            log_error "Failed to create Lightsail instance"
            log_warn "Common issues:"
            log_warn "  - Instance limit reached for your account"
            log_warn "  - Bundle unavailable in region (try different LIGHTSAIL_BUNDLE or LIGHTSAIL_REGION)"
            log_warn "  - AWS credentials lack Lightsail permissions (check IAM policy)"
            log_warn "  - Instance name '${name}' already in use"
            return 1
        fi
    else
        # REST path — write userdata to a temp file so bun can JSON-encode it safely
        local ud_tmp create_body
        ud_tmp=$(mktemp)
        printf '%s' "${userdata}" > "${ud_tmp}"
        create_body=$(bun eval "const ud=require('fs').readFileSync(process.argv[2],'utf8');process.stdout.write(JSON.stringify({instanceNames:[process.argv[3]],availabilityZone:process.argv[4],blueprintId:'ubuntu_24_04',bundleId:process.argv[5],keyPairName:'spawn-key',userData:ud}));" \
            "${ud_tmp}" "${name}" "${az}" "${bundle}")
        rm -f "${ud_tmp}"

        _lightsail_rest "Lightsail_20161128.CreateInstances" "${create_body}" >/dev/null || {
            log_error "Failed to create Lightsail instance"
            log_warn "Common issues:"
            log_warn "  - Instance limit reached for your account"
            log_warn "  - Bundle unavailable in region (try LIGHTSAIL_BUNDLE or LIGHTSAIL_REGION env vars)"
            log_warn "  - Credentials lack lightsail:CreateInstances permission"
            log_warn "  - Instance name '${name}' already in use"
            return 1
        }
    fi

    export LIGHTSAIL_INSTANCE_NAME="${name}"
    log_info "Instance creation initiated: ${name}"

    _wait_for_lightsail_instance "${name}"

    save_vm_connection "${LIGHTSAIL_SERVER_IP}" "ubuntu" "" "$name" "aws"
}

# Lightsail uses 'ubuntu' user, not 'root'
SSH_USER="ubuntu"

# SSH operations — delegates to shared helpers
verify_server_connectivity() { ssh_verify_connectivity "$@"; }
run_server() { ssh_run_server "$@"; }
upload_file() { ssh_upload_file "$@"; }
interactive_session() { ssh_interactive_session "$@"; }

wait_for_cloud_init() {
    local ip="${1}"
    local max_attempts=${2:-60}

    # First ensure SSH connectivity is established
    ssh_verify_connectivity "${ip}" 30 5 || return 1

    # Then wait for cloud-init completion marker
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS}" "test -f /home/ubuntu/.cloud-init-complete" "cloud-init" "${max_attempts}" 5
}

destroy_server() {
    local name="${1}"
    log_step "Destroying Lightsail instance ${name}..."
    if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
        if ! aws lightsail delete-instance --instance-name "${name}" >/dev/null; then
            log_error "Failed to destroy Lightsail instance '${name}'"
            log_warn "The instance may still be running and incurring charges."
            log_warn "Delete it manually: ${SPAWN_DASHBOARD_URL}"
            return 1
        fi
    else
        if ! _lightsail_rest "Lightsail_20161128.DeleteInstance" \
            "{\"instanceName\":\"${name}\",\"forceDeleteAddOns\":false}" >/dev/null; then
            log_error "Failed to destroy Lightsail instance '${name}'"
            log_warn "The instance may still be running and incurring charges."
            log_warn "Delete it manually: ${SPAWN_DASHBOARD_URL}"
            return 1
        fi
    fi
    log_info "Instance ${name} destroyed"
}

list_servers() {
    if [[ "${LIGHTSAIL_MODE}" == "cli" ]]; then
        aws lightsail get-instances \
            --query 'instances[].{Name:name,State:state.name,IP:publicIpAddress,Bundle:bundleId}' \
            --output table
    else
        local resp
        resp=$(_lightsail_rest "Lightsail_20161128.GetInstances" "{}")
        _LIST_DATA="${resp}" bun eval "
const instances = JSON.parse(process.env._LIST_DATA).instances ?? [];
const fmt = (s, w) => String(s ?? '').padEnd(w);
console.log(fmt('Name',30) + fmt('State',12) + fmt('IP',16) + 'Bundle');
console.log('-'.repeat(72));
for (const i of instances)
    console.log(fmt(i.name,30) + fmt(i.state?.name,12) + fmt(i.publicIpAddress ?? 'N/A',16) + (i.bundleId ?? ''));
"
    fi
}

# ============================================================
# Cloud adapter interface
# ============================================================

cloud_authenticate() { prompt_spawn_name; ensure_aws_cli; ensure_ssh_key; }
cloud_provision() { create_server "$1"; }
cloud_wait_ready() { verify_server_connectivity "${LIGHTSAIL_SERVER_IP}"; wait_for_cloud_init "${LIGHTSAIL_SERVER_IP}" 60; }
cloud_run() { run_server "${LIGHTSAIL_SERVER_IP}" "$1"; }
cloud_upload() { upload_file "${LIGHTSAIL_SERVER_IP}" "$1" "$2"; }
cloud_interactive() { interactive_session "${LIGHTSAIL_SERVER_IP}" "$1"; }
cloud_label() { echo "Lightsail instance"; }
