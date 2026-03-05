#!/bin/bash
set -eo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get install -y --no-install-recommends \
  curl \
  unzip \
  git \
  ca-certificates
