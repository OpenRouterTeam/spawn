FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates unzip && \
    rm -rf /var/lib/apt/lists/*

# Cursor CLI
RUN curl -fsSL https://cursor.com/install | bash || \
    [ -f /root/.local/bin/cursor ]

# Ensure tools are on PATH for all shells
RUN for rc in /root/.bashrc /root/.zshrc; do \
      grep -q '.local/bin' "$rc" 2>/dev/null || \
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"; \
    done

CMD ["/bin/sleep", "inf"]
