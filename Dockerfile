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

# Seed demo project (spinoff3 output only, no source files)
RUN mkdir -p server/projects/spinoff3/output
COPY server/projects/spinoff3/project.json ./server/projects/spinoff3/
COPY server/projects/spinoff3/output/ ./server/projects/spinoff3/output/

WORKDIR /app/server
EXPOSE 5176
CMD ["node", "unified-server.mjs"]
