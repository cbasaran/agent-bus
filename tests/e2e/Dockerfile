# The clean machine for tests/e2e/run.ts: Ubuntu 26.04 (bariton's release, so bariton's harness binaries run as they
# are) with Node, tmux and the tools the harnesses shell out to. Bun, the harnesses and this checkout are mounted from
# the host at run time; HOME is an empty folder per run.
FROM ubuntu:26.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs tmux git curl ca-certificates jq procps lsof ripgrep \
 && rm -rf /var/lib/apt/lists/*
ENV LANG=C.UTF-8 TERM=xterm-256color
