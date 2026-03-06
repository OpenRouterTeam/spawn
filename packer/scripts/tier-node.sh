#!/bin/bash
set -eo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  curl \
  unzip \
  git \
  ca-certificates \
  zsh \
  build-essential

# Node.js 22 via n
curl --proto '=https' -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22

# PATH setup
for rc in /root/.bashrc /root/.zshrc; do
  grep -q '.bun/bin' "$rc" 2>/dev/null || printf 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n' >> "$rc"
done
