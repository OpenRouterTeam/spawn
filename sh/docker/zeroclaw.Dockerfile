FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates build-essential unzip && \
    rm -rf /var/lib/apt/lists/*

# ZeroClaw — bootstrap script installs Rust + builds from source
RUN curl --proto '=https' -LsSf \
      https://raw.githubusercontent.com/zeroclaw-labs/zeroclaw/a117be64fdaa31779204beadf2942c8aef57d0e5/scripts/bootstrap.sh \
    | bash -s -- --install-rust --install-system-deps --prefer-prebuilt

# Ensure cargo bin is on PATH for all shells
RUN for rc in /root/.bashrc /root/.zshrc; do \
      grep -q '.cargo/bin' "$rc" 2>/dev/null || \
        echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$rc"; \
    done

CMD ["/bin/sleep", "inf"]
