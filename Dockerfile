FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for most platforms, but if none matches
# the target arch it falls back to compiling from source, which needs these.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

ENV NODE_ENV=production
VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
