packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.4.1"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "do_api_token" {
  type      = string
  sensitive = true
}

variable "agent_name" {
  type = string
}

variable "cloud_init_tier" {
  type    = string
  default = "minimal"
}

variable "install_commands" {
  type    = list(string)
  default = []
}

locals {
  timestamp  = formatdate("YYYYMMDD-hhmm", timestamp())
  image_name = "spawn-${var.agent_name}-${local.timestamp}"
}

source "digitalocean" "spawn" {
  api_token    = var.do_api_token
  image        = "ubuntu-24-04-x64"
  region       = "nyc3"
  size         = "s-2vcpu-4gb"
  ssh_username = "root"

  snapshot_name = local.image_name
  snapshot_regions = [
    "nyc1", "nyc3", "sfo3", "tor1", "ams3",
    "lon1", "fra1", "blr1", "sgp1", "syd1",
  ]

  tags = ["spawn", "spawn-${var.agent_name}"]
}

build {
  sources = ["source.digitalocean.spawn"]

  # Wait for cloud-init to finish (DO base images run it on first boot)
  provisioner "shell" {
    inline = [
      "cloud-init status --wait || true",
    ]
  }

  # Wait for any apt locks to be released (cloud-init may hold them)
  provisioner "shell" {
    inline = [
      "for i in $(seq 1 30); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; echo 'Waiting for apt lock...'; sleep 2; done",
    ]
  }

  # Run the tier script (installs base packages: curl, git, node, bun, etc.)
  provisioner "shell" {
    script = "packer/scripts/tier-${var.cloud_init_tier}.sh"
  }

  # Install the agent
  provisioner "shell" {
    inline = var.install_commands
    environment_vars = [
      "HOME=/root",
      "DEBIAN_FRONTEND=noninteractive",
    ]
  }

  # Leave a marker so the CLI knows this is a pre-baked snapshot
  provisioner "shell" {
    inline = [
      "echo 'spawn-${var.agent_name}' > /root/.spawn-snapshot",
      "date -u '+%Y-%m-%dT%H:%M:%SZ' >> /root/.spawn-snapshot",
      "touch /root/.cloud-init-complete",
    ]
  }

  # Clean up to reduce snapshot size
  provisioner "shell" {
    inline = [
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*",
      "sync",
    ]
  }
}
