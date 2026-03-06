#!/bin/bash
set -eo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  curl \
  unzip \
  git \
  ca-certificates \
  zsh

# Bun
if ! command -v bun >/dev/null 2>&1; then
  curl --proto '=https' -fsSL https://bun.sh/install | bash
fi
ln -sf /root/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true

# PATH setup
for rc in /root/.bashrc /root/.zshrc; do
  grep -q '.bun/bin' "$rc" 2>/dev/null || printf 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n' >> "$rc"
done
