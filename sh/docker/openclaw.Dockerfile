FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates build-essential unzip xz-utils zsh && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 via apt + n
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends nodejs npm && \
    npm install -g n && n 22 && \
    ln -sf /usr/local/bin/node /usr/bin/node && \
    ln -sf /usr/local/bin/npm /usr/bin/npm && \
    ln -sf /usr/local/bin/npx /usr/bin/npx && \
    rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/root/.local/bin:${PATH}"

# OpenClaw via npm (Node runtime needs standard node_modules layout)
RUN npm install -g openclaw
# Ensure tools are on PATH for all shells
RUN for rc in /root/.bashrc /root/.zshrc; do \
      grep -q '.bun/bin' "$rc" 2>/dev/null || \
        echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$rc"; \
    done

CMD ["/bin/sleep", "inf"]
