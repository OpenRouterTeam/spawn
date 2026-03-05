FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Base packages
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl git ca-certificates unzip xz-utils && \
    rm -rf /var/lib/apt/lists/*

# Hermes Agent
RUN curl --proto '=https' -fsSL \
      https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash

CMD ["/bin/sleep", "inf"]
