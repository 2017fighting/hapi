# syntax=docker/dockerfile:1
#
# hapi-hub — multi-arch Docker image.
#
# Build (single native arch):
#   docker build -t hapi-hub .
# Build (multi-arch, requires buildx):
#   docker buildx build --platform linux/amd64,linux/arm64 -t hapi-hub --load .
#     (use --push instead of --load to publish to a registry)
# Run:
#   docker run --rm -p 3006:3006 -v hapi-data:/data hapi-hub
#
# Topology: run behind a reverse proxy (Caddy/Traefik/nginx/Cloudflare Tunnel) that
# provides HTTPS + a public URL. Set HAPI_PUBLIC_URL / CORS_ORIGINS at runtime.
# See docs/guide/docker.md for full deployment guidance.

# ----------------------------------------------------------------------------
# Build stage — Debian base for build-tooling compatibility (Vite/esbuild ship
# glibc prebuilt binaries). Produces hub/dist/index.js + web/dist.
# ----------------------------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app

# Copy workspace manifests first so `bun install` is cached independently of source.
COPY package.json bun.lock tsconfig.base.json ./
COPY cli/package.json     cli/package.json
COPY shared/package.json  shared/package.json
COPY hub/package.json     hub/package.json
COPY web/package.json     web/package.json
COPY website/package.json website/package.json
COPY docs/package.json    docs/package.json

RUN bun install --frozen-lockfile

# Now copy the rest of the source.
COPY . .

# Build the web app -> web/dist (the hub serves these assets at runtime).
RUN bun run build:web

# Running `bun dist/index.js` is NOT a compiled executable, so isBunCompiled() is
# false and web assets are served from web/dist — never from the embedded manifest.
# Provide an empty manifest so the bundle resolves the dynamic import cleanly,
# without baking (and thus duplicating) all web assets into hub/dist/index.js.
RUN printf '%s\n' \
    'export interface EmbeddedWebAsset { path: string; sourcePath: string; mimeType: string; }' \
    'export const embeddedAssets: EmbeddedWebAsset[] = [];' \
    > hub/src/web/embeddedAssets.generated.ts

# Bundle the hub -> hub/dist/index.js.
RUN bun run build:hub

# ----------------------------------------------------------------------------
# Runtime stage — Alpine + native-musl Bun runtime (officially supported since
# Bun v1.1.35). No node_modules; the bundle is self-contained.
# ----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Runtime configuration.
# HAPI_LISTEN_HOST MUST be 0.0.0.0 — otherwise the hub binds to 127.0.0.1 inside
# the container and is unreachable through port mapping.
ENV NODE_ENV=production \
    HAPI_LISTEN_HOST=0.0.0.0 \
    HAPI_LISTEN_PORT=3006 \
    HAPI_HOME=/data \
    HOME=/data

# oven/bun:1-alpine already ships a non-root `bun` user at UID/GID 1000 — reuse it
# rather than creating our own. A fixed UID/GID 1000 means bind-mounted host dirs
# owned by 1000 work without extra setup; named volumes (e.g. hapi-data) need none.
RUN mkdir -p /data && chown -R 1000:1000 /data

# Ship only the built artifacts.
COPY --from=build --chown=1000:1000 /app/hub/dist /app/hub/dist
COPY --from=build --chown=1000:1000 /app/web/dist /app/web/dist

USER bun
WORKDIR /app/hub

# SQLite DB, auto-generated CLI_API_TOKEN, JWT/VAPID keys, and settings.json all
# live here — mount a volume or state is lost on container recreation.
VOLUME ["/data"]

EXPOSE 3006

# GET / serves the web index (HTTP 200) when assets are present; 503 otherwise.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:${HAPI_LISTEN_PORT}/ || exit 1

CMD ["bun", "dist/index.js"]
