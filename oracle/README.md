# Oracle Cloud Infrastructure

Oracle Cloud compute instances via OCI CLI. [Oracle Cloud](https://cloud.oracle.com/)

> Has a generous Always Free tier. Uses 'ubuntu' user for SSH. Requires OCI CLI installed and configured.

## Prerequisites

1. Install OCI CLI: `pip install oci-cli`
2. Configure: `oci setup config`
3. Set compartment: `export OCI_COMPARTMENT_ID=ocid1.compartment.oc1.....`

## Agents

#### Claude Code

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/oracle/claude.sh)
```

#### Aider

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/oracle/aider.sh)
```

#### Goose

```bash
bash <(curl -fsSL https://openrouter.ai/lab/spawn/oracle/goose.sh)
```

## Non-Interactive Mode

```bash
OCI_COMPARTMENT_ID=ocid1.compartment.oc1..... \
OCI_INSTANCE_NAME=dev-mk1 \
OPENROUTER_API_KEY=sk-or-v1-xxxxx \
  bash <(curl -fsSL https://openrouter.ai/lab/spawn/oracle/claude.sh)
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OCI_COMPARTMENT_ID` | OCI compartment OCID | Auto-detected |
| `OCI_INSTANCE_NAME` | Instance display name | Prompted |
| `OCI_SHAPE` | Compute shape | `VM.Standard.E2.1.Micro` |
| `OCI_SUBNET_ID` | Subnet OCID | Auto-created |
| `OCI_OCPUS` | OCPUs for flex shapes | `1` |
| `OCI_MEMORY_GB` | Memory (GB) for flex shapes | `4` |
| `OPENROUTER_API_KEY` | OpenRouter API key | OAuth or prompted |
