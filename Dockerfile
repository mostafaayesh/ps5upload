# ─── Stage 1: Build the Rust engine ─────────────────────────────────────────
FROM rust:1.82-slim-bookworm AS engine-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Copy the engine workspace — Cargo.lock lives at engine/
COPY engine/ ./engine/

# Pre-fetch dependencies before copying source for better layer caching
WORKDIR /src/engine
RUN cargo fetch

# Build only the engine binary; skip tests/benches
RUN cargo build --release -p ps5upload-engine

# ─── Stage 2: Build the React / Vite frontend ────────────────────────────────
FROM node:22-slim AS ui-builder

WORKDIR /app

# Install deps first so this layer is cached unless package files change
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source and build
COPY client/ .

# Build as a plain web app (no Tauri env → webInvoke shim is active)
# Output lands in /app/dist
RUN npm run build:vite

# ─── Stage 3: Runtime image ───────────────────────────────────────────────────
# Single container: Nginx (port 80) proxies /api/* to the engine (127.0.0.1:19113)
# Both processes are managed by the entrypoint script.
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # Remove default Nginx site
    && rm -f /etc/nginx/sites-enabled/default

# Engine binary
COPY --from=engine-builder /src/engine/target/release/ps5upload-engine /usr/local/bin/ps5upload-engine

# React SPA (served by Nginx)
COPY --from=ui-builder /app/dist /var/www/ps5upload

# Docker-specific configs
COPY docker/nginx.conf /etc/nginx/sites-enabled/ps5upload
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Engine listens on :19113 (internal loopback only — Nginx proxies it)
# Nginx listens on :80 (the public port)
EXPOSE 80

# PS5 address default — override with -e PS5_ADDR=<ip>:9113
ENV PS5_ADDR=192.168.1.x:9113

CMD ["/entrypoint.sh"]
