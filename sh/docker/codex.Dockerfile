FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates build-essential unzip zsh && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 via n
RUN curl --proto '=https' -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s install 22

# Codex CLI
RUN npm install -g @openai/codex

CMD ["/bin/sleep", "inf"]
