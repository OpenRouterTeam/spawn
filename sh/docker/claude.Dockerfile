FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates unzip && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 via n (fallback for npm install method)
RUN curl --proto '=https' -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22

# Claude Code — try curl installer first, fall back to npm
RUN curl --proto '=https' -fsSL https://claude.ai/install.sh | bash || \
    npm install -g @anthropic-ai/claude-code || true

# Ensure tools are on PATH for all shells
RUN for rc in /root/.bashrc /root/.zshrc; do \
      grep -q '.claude/local/bin' "$rc" 2>/dev/null || \
        echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$PATH"' >> "$rc"; \
    done

CMD ["/bin/sleep", "inf"]
