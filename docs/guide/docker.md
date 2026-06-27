# Deploy with Docker

Run the hapi **hub** in a container. The hub serves the web UI, the HTTP/SSE/Socket.IO APIs, and persists state in SQLite. The CLI runs on your own machines and connects to the hub — it is not part of this image.

## What you get

- Multi-stage image: builds on `oven/bun:1`, runs on `oven/bun:1-alpine` (native musl Bun runtime).
- Multi-arch: `linux/amd64` + `linux/arm64`.
- Non-root user (`bun`, UID/GID 1000 — the user the `oven/bun` image already ships), a `/data` volume for state, and an HTTP healthcheck.
- No native dependencies — SQLite is Bun's built-in `bun:sqlite`.

## Quick start (compose)

```bash
cp .env.example .env          # edit HAPI_PUBLIC_URL (+ optional tokens)
docker compose up -d --build
docker compose logs -f hub    # first run prints the auto-generated CLI_API_TOKEN
```

State (SQLite DB, `CLI_API_TOKEN`, JWT/VAPID keys, `settings.json`) lives in the named `hapi-data` volume and survives container recreation.

## Quick start (plain Docker)

```bash
docker build -t hapi-hub .

docker run -d --name hapi-hub \
  -p 3006:3006 \
  -v hapi-data:/data \
  -e HAPI_PUBLIC_URL=https://hapi.example.com \
  --restart unless-stopped \
  hapi-hub

docker logs -f hapi-hub        # grab the auto-generated CLI_API_TOKEN
```

Then point your CLI and web login at `https://hapi.example.com` using that token.

## Put it behind a reverse proxy

The hub speaks **HTTP on port 3006**. Telegram Mini Apps and secure browser access require **HTTPS + a public URL**, which the hub does not terminate itself — put a reverse proxy in front.

```text
Browser/Telegram ──HTTPS──▶ Caddy/Traefik/nginx/Cloudflare Tunnel ──HTTP──▶ hub:3006
```

Set `HAPI_PUBLIC_URL` to the public HTTPS origin (used for the Telegram Mini App and to derive default CORS origins). If the web UI is hosted on a different origin, also set `CORS_ORIGINS`.

A minimal Caddyfile:

```caddyfile
hapi.example.com {
    reverse_proxy hapi-hub:3006
}
```

::: tip
If you instead want the hub to obtain a public URL on its own (no external proxy), it can use its built-in `tunwg` tunnel — but that requires the `--relay` flag and the `tunwg` binary, which this image does **not** ship. Use the reverse-proxy topology for the Docker image.
:::

## Configuration

All settings are environment variables, read at startup (env > `settings.json` > default). See `.env.example` for the full list. The most common:

| Variable | Default | Purpose |
|---|---|---|
| `CLI_API_TOKEN` | auto-generated | Shared secret for CLI + web login (clients append `:<namespace>`). Persisted in `/data`. |
| `HAPI_PUBLIC_URL` | — | Public HTTPS origin (set by your reverse proxy). |
| `CORS_ORIGINS` | from `HAPI_PUBLIC_URL` | Comma-separated allowed origins, or `*`. |
| `HAPI_LISTEN_HOST` | `0.0.0.0` (image default) | Bind address. The Dockerfile forces `0.0.0.0`. |
| `HAPI_LISTEN_PORT` | `3006` | HTTP port. |
| `HAPI_HOME` | `/data` (image default) | Data directory (the volume mount point). |
| `TELEGRAM_BOT_TOKEN` | — | Enables the Telegram bot / Mini App. |
| `ELEVENLABS_API_KEY` | — | Enables the voice assistant. |

::: warning
The hub's source default for `HAPI_LISTEN_HOST` is `127.0.0.1`. The Dockerfile overrides it to `0.0.0.0` — **do not set it back to `127.0.0.1`** or the container will bind to loopback and be unreachable through port mapping.
:::

## Persistence and the `/data` volume

Everything stateful lives under `HAPI_HOME=/data`:

- `hapi.db` — the SQLite database (sessions, messages, machines, users).
- The auto-generated `CLI_API_TOKEN`, JWT secret, and VAPID keys.
- `settings.json` — persisted configuration.

**Always mount a volume** (`-v hapi-data:/data`, or the compose named volume). Without it, every container recreation loses your token (breaking all CLI/web logins) and wipes the database.

### Bind-mounting a host directory (UID 1000 caveat)

The container runs as UID/GID **1000**. If you bind-mount a host directory (`-v ./data:/data`) instead of using a named volume, that directory must be writable by UID 1000:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

Named volumes (the compose default) handle ownership automatically and avoid this entirely.

## Multi-arch builds

The image builds for both `linux/amd64` and `linux/arm64` (covers x86 cloud, Apple Silicon, ARM VPS). Requires Docker Buildx:

```bash
docker buildx create --use            # one-time, if you have no builder
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t hapi-hub \
  --load .                            # use --push to publish to a registry
```

::: tip
The hub runs as an **interpreted bundle** (`bun dist/index.js`), not a compiled executable. Bun's `--compile` only produces glibc binaries and cannot target Alpine/musl, so the interpreted runtime on the official musl Bun image is the supported path.
:::

## Publishing via CI

`.github/workflows/docker.yml` builds the multi-arch image and pushes it to GHCR (`ghcr.io/<owner>/hapi-hub`) on any `v*` tag, tagging `:version`, `:major.minor`, `:major`, and `:latest` (on the default branch).

```bash
git tag v1.2.3 && git push --tags
```

The workflow uses `GITHUB_TOKEN` — no extra secret needed. To pull a private image, authenticate with a PAT that has `read:packages`.

## Troubleshooting

- **Can't reach the hub from the host / port mapping does nothing.** `HAPI_LISTEN_HOST` is `127.0.0.1`. Ensure you haven't overridden it; the Dockerfile sets `0.0.0.0`.
- **`docker compose up` regenerates the CLI_API_TOKEN every time.** The `/data` volume isn't persisting — confirm the volume mount, and that the host dir (if bind-mounted) is writable by UID 1000.
- **Healthcheck is `unhealthy`.** `GET /` returns 503 when web assets are missing, which means the build stage failed to produce `web/dist`. Rebuild with `--no-cache`.
- **First-run token.** If you didn't set `CLI_API_TOKEN`, the hub generates one and logs it once — `docker compose logs hub | grep -i token`.
