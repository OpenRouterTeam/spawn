FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates unzip && \
    rm -rf /var/lib/apt/lists/*

# OpenCode — download latest release binary
RUN OC_ARCH=$(uname -m) && \
    case "$OC_ARCH" in aarch64) OC_ARCH=arm64;; x86_64) OC_ARCH=x64;; esac && \
    OC_OS=$(uname -s | tr A-Z a-z) && \
    mkdir -p /tmp/opencode-install /root/.opencode/bin && \
    curl --proto '=https' -fsSL -o /tmp/opencode-install/oc.tar.gz \
      "https://github.com/sst/opencode/releases/latest/download/opencode-${OC_OS}-${OC_ARCH}.tar.gz" && \
    tar xzf /tmp/opencode-install/oc.tar.gz -C /tmp/opencode-install && \
    mv /tmp/opencode-install/opencode /root/.opencode/bin/ && \
    rm -rf /tmp/opencode-install

# Ensure tools are on PATH for all shells
RUN for rc in /root/.bashrc /root/.zshrc; do \
      grep -q '.opencode/bin' "$rc" 2>/dev/null || \
        echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> "$rc"; \
    done

CMD ["/bin/sleep", "inf"]
