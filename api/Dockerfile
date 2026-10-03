# Build from repository root: docker build -f api/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY api api
RUN npm run build -w api

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace=@travelfolio/api --include-workspace-root \
    && npm cache clean --force
COPY --from=build --chown=node:node /app/api/dist ./api/dist
COPY --chown=node:node api/migrations ./api/migrations
RUN mkdir -p /data/jobs && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "api/dist/main.js"]

# Browser-enabled worker image; API uses the smaller runtime target above.
FROM runtime AS worker-runtime
USER root
COPY --from=nginx:1.28-alpine /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
USER node
CMD ["node", "api/dist/worker-main.js"]
