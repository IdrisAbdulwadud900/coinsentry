# --- Stage 1: build the backend (TypeScript -> dist/) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: runtime image ---
FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 8787
# Sized to fit a 1024MB machine, not to be generous. 768 was too high: V8 happily grew the
# heap toward it and the kernel OOM-killed the process at 855MB RSS ("Out of memory: Killed
# process ... anon-rss:855692kB"), which is a harder failure than the V8 heap limit it was
# meant to fix. 512 heap + ~150MB of non-heap runtime leaves real headroom under the cap.
# The dump is taken from inside the scan loop (see maybeDumpHeap in poller.ts) rather than
# via --heapsnapshot-near-heap-limit: at the heap limit V8 no longer has the memory to
# serialise a snapshot, and every file it produced was 0 bytes.
WORKDIR /data
CMD ["node", "--max-old-space-size=512", "/app/dist/index.js"]
