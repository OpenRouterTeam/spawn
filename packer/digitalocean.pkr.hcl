packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.4.0"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

# ─── Variables ───────────────────────────────────────────────────────────────

variable "do_api_token" {
  type        = string
  sensitive   = true
  description = "DigitalOcean API token"
}

variable "agent_name" {
  type        = string
  description = "Agent identifier (e.g. claude, codex, openclaw)"
}

variable "cloud_init_tier" {
  type        = string
  default     = "full"
  description = "Package tier: minimal, node, bun, full"
}

variable "install_commands" {
  type        = list(string)
  default     = []
  description = "Shell commands to install the agent"
}

variable "region" {
  type        = string
  default     = "nyc3"
  description = "Build region"
}

variable "size" {
  type        = string
  default     = "s-2vcpu-4gb"
  description = "Droplet size for the build VM"
}

variable "base_image" {
  type        = string
  default     = "ubuntu-24-04-x64"
  description = "Base image slug"
}

# ─── Locals ──────────────────────────────────────────────────────────────────

locals {
  snapshot_name = "spawn-${var.agent_name}-${formatdate("YYYYMMDD", timestamp())}"
}

# ─── Source ──────────────────────────────────────────────────────────────────

source "digitalocean" "agent" {
  api_token     = var.do_api_token
  image         = var.base_image
  region        = var.region
  size          = var.size
  ssh_username  = "root"
  snapshot_name = local.snapshot_name

  snapshot_regions = [
    "nyc1", "nyc3", "sfo3", "ams3", "sgp1",
    "lon1", "fra1", "tor1", "blr1", "syd1",
  ]

  tags = ["spawn", "spawn-${var.agent_name}"]
}

# ─── Build ───────────────────────────────────────────────────────────────────

build {
  sources = ["source.digitalocean.agent"]

  # 0. Wait for cloud-init / apt lock to be released
  provisioner "shell" {
    inline = [
      "cloud-init status --wait || true",
      "while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 2; done",
    ]
  }

  # 1. System update
  provisioner "shell" {
    inline = [
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -y",
      "apt-get upgrade -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold'",
    ]
  }

  # 2. Tier packages + runtimes
  provisioner "shell" {
    script = "scripts/tier-${var.cloud_init_tier}.sh"
  }

  # 3. Agent install (15 min timeout, 2 retries via wrapper)
  provisioner "shell" {
    inline            = var.install_commands
    timeout           = "15m"
    max_retries       = 2
    expect_disconnect = false
    environment_vars = [
      "HOME=/root",
      "DEBIAN_FRONTEND=noninteractive",
    ]
  }

  # 4. Marker file + PATH setup
  provisioner "shell" {
    inline = [
      "echo 'agent=${var.agent_name}' > /root/.spawn-snapshot",
      "echo 'built=${formatdate("YYYY-MM-DD", timestamp())}' >> /root/.spawn-snapshot",
      "for rc in /root/.bashrc /root/.zshrc; do grep -q '.bun/bin' \"$rc\" 2>/dev/null || echo 'export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$PATH\"' >> \"$rc\"; done",
    ]
  }

  # 5. Cleanup
  provisioner "shell" {
    inline = [
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*",
      "rm -f /var/log/cloud-init*.log /var/log/syslog /var/log/auth.log",
      "truncate -s 0 /var/log/lastlog /var/log/wtmp /var/log/btmp 2>/dev/null || true",
      "sync",
    ]
  }
}
