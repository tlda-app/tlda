FROM node:20-slim
WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --production

# Copy server code (not projects — those are seeded separately)
COPY server/lib/ ./server/lib/
COPY server/routes/ ./server/routes/
COPY server/unified-server.mjs ./server/

# Build the viewer SPA
COPY package.json vite.config.ts tsconfig*.json index.html ./
COPY shared/ ./shared/
COPY src/ ./src/
RUN npm install --ignore-scripts && npx vite build && \
    mkdir -p server/public && cp -r dist/* server/public/ && \
    rm -rf node_modules dist src

# Seed project data (output only, no source files) into /app/server/seed/
# On startup, project.json and output/ are copied to projects/ (but sync-snapshot.json
# on the persistent volume is preserved across deploys).
# Copy all projects that have output/ dirs — the entrypoint iterates dynamically.
COPY server/projects/ ./server/projects-tmp/
RUN mkdir -p server/seed && \
    for proj in server/projects-tmp/*/; do \
      name=$(basename "$proj"); \
      if [ -d "$proj/output" ] && [ -f "$proj/project.json" ]; then \
        mkdir -p "server/seed/$name/output" && \
        cp "$proj/project.json" "server/seed/$name/" && \
        cp -r "$proj/output/." "server/seed/$name/output/"; \
      fi; \
    done && \
    rm -rf server/projects-tmp/

# Entrypoint: seed project data, preserving persistent sync snapshots
COPY scripts/fly-entrypoint.sh ./
RUN chmod +x fly-entrypoint.sh

WORKDIR /app/server
EXPOSE 5176
CMD ["/app/fly-entrypoint.sh"]
