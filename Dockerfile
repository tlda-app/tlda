FROM node:20-slim
WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --production

# Copy server code (not projects — those are seeded separately)
COPY server/lib/ ./server/lib/
COPY server/routes/ ./server/routes/
COPY server/unified-server.mjs ./server/
COPY server/sync-server.js ./server/

# Build the viewer SPA
COPY package.json vite.config.ts tsconfig*.json index.html ./
COPY shared/ ./shared/
COPY src/ ./src/
COPY public/ ./public/
RUN npm install --ignore-scripts && npx vite build && \
    mkdir -p server/public && cp -r dist/* server/public/ && \
    rm -rf node_modules dist src public

# Seed project data (output only, no source files) into /app/server/seed/
# On startup, project.json and output/ are copied to projects/ (but sync-snapshot.json
# on the persistent volume is preserved across deploys).
RUN mkdir -p server/seed/spinoff3/output server/seed/qtm285/output
COPY server/projects/spinoff3/project.json ./server/seed/spinoff3/
COPY server/projects/spinoff3/output/ ./server/seed/spinoff3/output/
COPY server/projects/qtm285/project.json ./server/seed/qtm285/
COPY server/projects/qtm285/output/ ./server/seed/qtm285/output/

# Entrypoint: seed project data, preserving persistent sync snapshots
COPY scripts/fly-entrypoint.sh ./
RUN chmod +x fly-entrypoint.sh

WORKDIR /app/server
EXPOSE 5176
CMD ["/app/fly-entrypoint.sh"]
