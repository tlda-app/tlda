# Dockerfile — a lightweight "second machine" for testing the multi-machine /
# collaborator flow (the daemon-side source binding, `tlda doc link`).
#
# Runs the tlda CLI + fleet-daemon ONLY. NO TeXLive: a collaborator's daemon just
# watches and pushes source over the WS; the HOST server does the LaTeX build. So
# this image is small. Native deps (better-sqlite3) are rebuilt for Linux here.
#
# Build context = repo root (so the daemon-side-binding code is included):
#   docker build -f test/collab-box/Dockerfile -t tlda-collab .
FROM node:20-slim
WORKDIR /opt/tlda

RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the tlda source (see .dockerignore — node_modules/.git/projects excluded)
# and install production deps, compiling better-sqlite3 for this (Linux) platform.
COPY . /opt/tlda
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3

# Put the CLI on PATH as `tlda`.
RUN ln -sf /opt/tlda/cli/tlda.mjs /usr/local/bin/tlda && chmod +x /opt/tlda/cli/tlda.mjs

# The collaborator's local clone of the test paper is mounted at /work at run time.
WORKDIR /work
ENTRYPOINT ["/bin/bash"]
