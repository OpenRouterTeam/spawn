#!/bin/bash
# Common bash functions for Oracle Cloud Infrastructure (OCI) spawn scripts
# Uses OCI CLI (oci) — requires oci-cli installed and configured

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

# ============================================================
# OCI specific functions
# ============================================================

# SSH_OPTS is defined in shared/common.sh

# Configurable timeout/delay constants
INSTANCE_STATUS_POLL_DELAY=${INSTANCE_STATUS_POLL_DELAY:-5}

ensure_oci_cli() {
    if ! command -v oci &>/dev/null; then
        log_error "OCI CLI is required but not installed."
        log_error ""
        log_error "Install with: pip install oci-cli"
        log_error "Or: bash -c \"\$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)\""
        log_error ""
        log_error "After installing, run: oci setup config"
        return 1
    fi

    # Verify config exists
    if [[ ! -f "${HOME}/.oci/config" ]]; then
        log_error "OCI CLI not configured. Run: oci setup config"
        log_error ""
        log_error "You will need:"
        log_error "  - Tenancy OCID (from OCI Console > Administration > Tenancy Details)"
        log_error "  - User OCID (from OCI Console > Profile > User Settings)"
        log_error "  - Compartment OCID (from OCI Console > Identity > Compartments)"
        log_error "  - Region (e.g., us-ashburn-1)"
        log_error "  - API signing key pair (generated during setup)"
        return 1
    fi

    # Get compartment ID
    local compartment="${OCI_COMPARTMENT_ID:-}"
    if [[ -z "${compartment}" ]]; then
        # Try to get tenancy OCID as default compartment (root compartment)
        compartment=$(oci iam compartment list --compartment-id-in-subtree true --all \
            --query 'data[0]."compartment-id"' --raw-output 2>/dev/null || true)
        if [[ -z "${compartment}" ]]; then
            log_error "OCI_COMPARTMENT_ID not set and could not detect compartment."
            log_error ""
            log_error "Set it with: export OCI_COMPARTMENT_ID=ocid1.compartment.oc1....."
            log_error "Find it in: OCI Console > Identity > Compartments"
            return 1
        fi
    fi
    export OCI_COMPARTMENT_ID="${compartment}"
    log_info "Using OCI compartment: ${compartment}"
}

ensure_ssh_key() {
    local key_path="${HOME}/.ssh/id_ed25519"

    # Generate key if needed
    generate_ssh_key_if_missing "${key_path}"

    # OCI handles SSH keys via instance metadata during create
    log_info "SSH key ready"
}

get_server_name() {
    get_resource_name "OCI_INSTANCE_NAME" "Enter OCI instance name: "
}

get_cloud_init_userdata() {
    cat << 'CLOUD_INIT_EOF'
#!/bin/bash
apt-get update -y
apt-get install -y curl unzip git zsh python3
# Install Bun
su - ubuntu -c 'curl -fsSL https://bun.sh/install | bash' || true
# Install Claude Code
su - ubuntu -c 'curl -fsSL https://claude.ai/install.sh | bash' || true
# Configure PATH
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.bashrc
echo 'export PATH="${HOME}/.claude/local/bin:${HOME}/.bun/bin:${PATH}"' >> /home/ubuntu/.zshrc
touch /home/ubuntu/.cloud-init-complete
chown ubuntu:ubuntu /home/ubuntu/.cloud-init-complete
CLOUD_INIT_EOF
}

_get_ubuntu_image_id() {
    local compartment="${OCI_COMPARTMENT_ID}"
    local shape="${1:-VM.Standard.E2.1.Micro}"

    # Determine OS for the shape - ARM shapes need aarch64
    local os_match="Canonical Ubuntu"
    local os_version="24.04"

    local image_id
    image_id=$(oci compute image list \
        --compartment-id "${compartment}" \
        --operating-system "${os_match}" \
        --operating-system-version "${os_version}" \
        --shape "${shape}" \
        --sort-by TIMECREATED \
        --sort-order DESC \
        --limit 1 \
        --query 'data[0].id' \
        --raw-output 2>/dev/null || true)

    if [[ -z "${image_id}" || "${image_id}" == "null" ]]; then
        # Fallback: try without shape filter
        image_id=$(oci compute image list \
            --compartment-id "${compartment}" \
            --operating-system "${os_match}" \
            --operating-system-version "${os_version}" \
            --sort-by TIMECREATED \
            --sort-order DESC \
            --limit 1 \
            --query 'data[0].id' \
            --raw-output 2>/dev/null || true)
    fi

    if [[ -z "${image_id}" || "${image_id}" == "null" ]]; then
        log_error "Could not find Ubuntu 24.04 image for shape ${shape}"
        log_error "Check available images: oci compute image list --compartment-id ${compartment} --all"
        return 1
    fi

    echo "${image_id}"
}

_get_availability_domain() {
    local compartment="${OCI_COMPARTMENT_ID}"

    local ad
    ad=$(oci iam availability-domain list \
        --compartment-id "${compartment}" \
        --query 'data[0].name' \
        --raw-output 2>/dev/null || true)

    if [[ -z "${ad}" || "${ad}" == "null" ]]; then
        log_error "Could not list availability domains"
        return 1
    fi

    echo "${ad}"
}

_get_subnet_id() {
    local compartment="${OCI_COMPARTMENT_ID}"

    # Try to find an existing public subnet
    local subnet_id
    subnet_id=$(oci network subnet list \
        --compartment-id "${compartment}" \
        --query 'data[?("prohibit-public-ip-on-vnic"==`false`)].id | [0]' \
        --raw-output 2>/dev/null || true)

    if [[ -n "${subnet_id}" && "${subnet_id}" != "null" ]]; then
        echo "${subnet_id}"
        return 0
    fi

    # No public subnet found - create a VCN and subnet
    log_warn "No public subnet found. Creating VCN and subnet..."

    # Create VCN
    local vcn_result
    vcn_result=$(oci network vcn create \
        --compartment-id "${compartment}" \
        --cidr-blocks '["10.0.0.0/16"]' \
        --display-name "spawn-vcn" \
        --dns-label "spawnvcn" \
        --wait-for-state AVAILABLE \
        --query 'data.id' \
        --raw-output 2>/dev/null)

    if [[ -z "${vcn_result}" || "${vcn_result}" == "null" ]]; then
        log_error "Failed to create VCN"
        return 1
    fi
    local vcn_id="${vcn_result}"

    # Create internet gateway
    local igw_result
    igw_result=$(oci network internet-gateway create \
        --compartment-id "${compartment}" \
        --vcn-id "${vcn_id}" \
        --display-name "spawn-igw" \
        --is-enabled true \
        --wait-for-state AVAILABLE \
        --query 'data.id' \
        --raw-output 2>/dev/null)

    # Get default route table and add internet route
    local rt_id
    rt_id=$(oci network route-table list \
        --compartment-id "${compartment}" \
        --vcn-id "${vcn_id}" \
        --query 'data[0].id' \
        --raw-output 2>/dev/null)

    if [[ -n "${rt_id}" && "${rt_id}" != "null" && -n "${igw_result}" && "${igw_result}" != "null" ]]; then
        oci network route-table update \
            --rt-id "${rt_id}" \
            --route-rules "[{\"destination\":\"0.0.0.0/0\",\"networkEntityId\":\"${igw_result}\",\"destinationType\":\"CIDR_BLOCK\"}]" \
            --force \
            --wait-for-state AVAILABLE >/dev/null 2>&1 || true
    fi

    # Get default security list and add SSH ingress rule
    local sl_id
    sl_id=$(oci network security-list list \
        --compartment-id "${compartment}" \
        --vcn-id "${vcn_id}" \
        --query 'data[0].id' \
        --raw-output 2>/dev/null)

    if [[ -n "${sl_id}" && "${sl_id}" != "null" ]]; then
        oci network security-list update \
            --security-list-id "${sl_id}" \
            --ingress-security-rules '[{"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":22,"max":22}},"isStateless":false}]' \
            --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
            --force \
            --wait-for-state AVAILABLE >/dev/null 2>&1 || true
    fi

    # Get AD for subnet
    local ad
    ad=$(_get_availability_domain)

    # Create public subnet
    subnet_id=$(oci network subnet create \
        --compartment-id "${compartment}" \
        --vcn-id "${vcn_id}" \
        --cidr-block "10.0.1.0/24" \
        --display-name "spawn-subnet" \
        --availability-domain "${ad}" \
        --dns-label "spawnsubnet" \
        --wait-for-state AVAILABLE \
        --query 'data.id' \
        --raw-output 2>/dev/null)

    if [[ -z "${subnet_id}" || "${subnet_id}" == "null" ]]; then
        log_error "Failed to create subnet"
        return 1
    fi

    echo "${subnet_id}"
}

create_server() {
    local name="${1}"
    local shape="${OCI_SHAPE:-VM.Standard.E2.1.Micro}"

    log_warn "Creating OCI instance '${name}' (shape: ${shape})..."

    # Get image ID
    local image_id
    image_id=$(_get_ubuntu_image_id "${shape}") || return 1

    # Get availability domain
    local ad
    ad=$(_get_availability_domain) || return 1

    # Get or create subnet
    local subnet_id="${OCI_SUBNET_ID:-}"
    if [[ -z "${subnet_id}" ]]; then
        subnet_id=$(_get_subnet_id) || return 1
    fi

    # Read SSH public key
    local pub_key
    pub_key=$(cat "${HOME}/.ssh/id_ed25519.pub")

    # Get cloud-init userdata
    local userdata
    userdata=$(get_cloud_init_userdata)
    local userdata_b64
    userdata_b64=$(printf '%s' "${userdata}" | base64 -w0 2>/dev/null || printf '%s' "${userdata}" | base64)

    # Build shape config for flex shapes
    local shape_config_args=()
    if [[ "${shape}" == *".Flex" || "${shape}" == *".Flex."* ]]; then
        local ocpus="${OCI_OCPUS:-1}"
        local memory="${OCI_MEMORY_GB:-4}"
        shape_config_args=(--shape-config "{\"ocpus\": ${ocpus}, \"memoryInGBs\": ${memory}}")
    fi

    # Create the instance
    local result
    result=$(oci compute instance launch \
        --compartment-id "${OCI_COMPARTMENT_ID}" \
        --availability-domain "${ad}" \
        --shape "${shape}" \
        "${shape_config_args[@]}" \
        --image-id "${image_id}" \
        --subnet-id "${subnet_id}" \
        --display-name "${name}" \
        --assign-public-ip true \
        --ssh-authorized-keys-file "${HOME}/.ssh/id_ed25519.pub" \
        --user-data "${userdata_b64}" \
        --wait-for-state RUNNING \
        --query 'data.id' \
        --raw-output 2>/dev/null) || true

    if [[ -z "${result}" || "${result}" == "null" ]]; then
        log_error "Failed to create OCI instance"
        log_error "Check your quota and compartment permissions"
        return 1
    fi

    export OCI_INSTANCE_ID="${result}"
    export OCI_INSTANCE_NAME_ACTUAL="${name}"

    # Get public IP
    local vnic_attachments
    vnic_attachments=$(oci compute vnic-attachment list \
        --compartment-id "${OCI_COMPARTMENT_ID}" \
        --instance-id "${result}" \
        --query 'data[0]."vnic-id"' \
        --raw-output 2>/dev/null)

    local server_ip=""
    if [[ -n "${vnic_attachments}" && "${vnic_attachments}" != "null" ]]; then
        server_ip=$(oci network vnic get \
            --vnic-id "${vnic_attachments}" \
            --query 'data."public-ip"' \
            --raw-output 2>/dev/null || true)
    fi

    if [[ -z "${server_ip}" || "${server_ip}" == "null" ]]; then
        log_error "Could not get public IP for instance"
        return 1
    fi

    export OCI_SERVER_IP="${server_ip}"
    log_info "Instance created: IP=${OCI_SERVER_IP}"
}

verify_server_connectivity() {
    local ip="${1}" max_attempts=${2:-30}
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS}" "echo ok" "SSH connectivity" "${max_attempts}"
}

wait_for_cloud_init() {
    local ip="${1}"
    local max_attempts=${2:-60}

    # First ensure SSH connectivity
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS}" "echo ok" "SSH connectivity" 30 5 || return 1

    # Then wait for cloud-init completion marker
    generic_ssh_wait "ubuntu" "${ip}" "${SSH_OPTS}" "test -f /home/ubuntu/.cloud-init-complete" "cloud-init" "${max_attempts}" 5
}

# OCI Ubuntu images use 'ubuntu' user
# shellcheck disable=SC2086
run_server() { local ip="${1}" cmd="${2}"; ssh ${SSH_OPTS} "ubuntu@${ip}" "${cmd}"; }
# shellcheck disable=SC2086
upload_file() { local ip="${1}" local_path="${2}" remote_path="${3}"; scp ${SSH_OPTS} "${local_path}" "ubuntu@${ip}:${remote_path}"; }
# shellcheck disable=SC2086
interactive_session() { local ip="${1}" cmd="${2}"; ssh -t ${SSH_OPTS} "ubuntu@${ip}" "${cmd}"; }

destroy_server() {
    local instance_id="${1:-${OCI_INSTANCE_ID:-}}"
    if [[ -z "${instance_id}" ]]; then
        log_error "No instance ID provided. Usage: destroy_server INSTANCE_OCID"
        return 1
    fi
    log_warn "Terminating OCI instance ${instance_id}..."
    oci compute instance terminate \
        --instance-id "${instance_id}" \
        --preserve-boot-volume false \
        --force >/dev/null 2>&1
    log_info "Instance terminated"
}

list_servers() {
    oci compute instance list \
        --compartment-id "${OCI_COMPARTMENT_ID}" \
        --query 'data[?("lifecycle-state"!=`TERMINATED`)].{"Name":"display-name","State":"lifecycle-state","Shape":"shape","Created":"time-created"}' \
        --output table 2>/dev/null
}
