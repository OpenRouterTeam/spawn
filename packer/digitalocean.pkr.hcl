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
  region       = "sfo3"
  # DO Marketplace recommends the smallest droplet ($6/mo s-1vcpu-1gb) for
  # build compatibility — snapshots built on s-1vcpu-1gb work on all sizes.
  size         = "s-1vcpu-1gb"
  ssh_username = "root"

  snapshot_name = local.image_name
  snapshot_regions = [
    "nyc1", "nyc3", "sfo3", "tor1", "ams3",
    "lon1", "fra1", "blr1", "sgp1", "syd1",
  ]
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

  # DO Marketplace requirement: enable ufw firewall with SSH allowed
  provisioner "shell" {
    inline = [
      "apt-get install -y ufw",
      "ufw default deny incoming",
      "ufw default allow outgoing",
      "ufw allow ssh",
      "ufw --force enable",
    ]
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
    ]
  }

  # Install the agent
  provisioner "shell" {
    inline = var.install_commands
    environment_vars = [
      "HOME=/root",
      "DEBIAN_FRONTEND=noninteractive",
      "PATH=/root/.local/bin:/root/.bun/bin:/root/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]
  }

  # Leave a marker so the CLI knows this is a pre-baked snapshot
  provisioner "shell" {
    inline = [
      "echo 'spawn-${var.agent_name}' > /root/.spawn-snapshot",
      "date -u '+%Y-%m-%dT%H:%M:%SZ' >> /root/.spawn-snapshot",
      "touch /root/.cloud-init-complete",
    ]
    environment_vars = [
      "HOME=/root",
      "PATH=/root/.local/bin:/root/.bun/bin:/root/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]
  }

  # DO Marketplace cleanup — runs last before snapshot.
  # Based on https://github.com/digitalocean/marketplace-partners/blob/master/scripts/cleanup.sh
  # Clears secrets, history, logs, and machine-id so each launched droplet
  # gets a fresh identity. cloud-init re-runs on first boot to re-inject keys.
  provisioner "shell" {
    inline = [
      # Remove SSH authorized keys (cloud-init re-injects them on first boot)
      "rm -f /root/.ssh/authorized_keys",
      "find /home -name authorized_keys -delete",

      # Clear bash history
      "history -c",
      "rm -f /root/.bash_history",
      "find /home -name .bash_history -delete",

      # Purge log files
      "find /var/log -type f -exec truncate --size 0 {} \\;",

      # Clear apt cache
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",

      # Clear tmp
      "rm -rf /tmp/* /var/tmp/*",

      # Remove machine-id so each launched droplet gets a unique one
      "truncate -s 0 /etc/machine-id",
      "rm -f /var/lib/dbus/machine-id",
      "ln -sf /etc/machine-id /var/lib/dbus/machine-id",

      # Reset cloud-init so it runs again on first boot (re-injects SSH keys, hostname, etc.)
      "cloud-init clean --logs",

      "sync",
    ]
  }

  # DO Marketplace validation — download and run img_check.sh to verify the image
  # meets marketplace requirements (firewall active, no root password, etc.)
  provisioner "shell" {
    inline = [
      "curl -fsSL https://raw.githubusercontent.com/digitalocean/marketplace-partners/master/scripts/img_check.sh -o /tmp/img_check.sh",
      "chmod +x /tmp/img_check.sh",
      "/tmp/img_check.sh",
      "rm -f /tmp/img_check.sh",
    ]
  }
}
