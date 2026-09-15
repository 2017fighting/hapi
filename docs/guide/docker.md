# Deploy with Docker

The fork publishes a multi-arch (`linux/amd64`, `linux/arm64`) image of the upstream hub + web app:

```
ghcr.io/2017fighting/hapi-hub:<version>
```

This branch carries **no product changes** — it is upstream code plus the Docker overlay (see [`ADR 0001`](/adr/0001-thin-docker-overlay-tracking-upstream-tags) and the repo root `CONTEXT.md`). Images are built automatically whenever a new upstream release tag is merged (daily check, 02:00 UTC).

## What you get

- The hub (API + Socket.IO + SSE) serving the bundled web PWA on port `3006`.
- State in a single `/data` volume: auto-generated `CLI_API_TOKEN`, JWT/VAPID keys, `settings.json`, and the SQLite database (`hapi.db`).
- Non-root runtime user (`bun`, UID/GID 1000).

## Quick start (plain Docker)

```bash
docker run -d --name hapi-hub \
  -p 3006:3006 \
  -v hapi-data:/data \
  -e HAPI_PUBLIC_URL=https://hapi.example.com \
  ghcr.io/2017fighting/hapi-hub:0.29.0

# First-run CLI_API_TOKEN:
docker logs hapi-hub 2>&1 | head
```

## Quick start (compose)

The repo intentionally ships no `docker-compose.yml`; if you use compose, inline it:

```yaml
services:
  hub:
    image: ghcr.io/2017fighting/hapi-hub:0.29.0 # pin a version tag
    restart: unless-stopped
    ports:
      - "3006:3006"
    environment:
      HAPI_PUBLIC_URL: https://hapi.example.com
    volumes:
      - hapi-data:/data

volumes:
  hapi-data:
```

## Kubernetes notes

- **Pin a version tag** (`image: .../hapi-hub:0.29.0`); roll forward by bumping the tag, roll back by reverting it.
- **Exactly one replica** — the hub is single-writer (SQLite + token/keys in `/data`). Use a `ReadWriteOnce` PVC on `/data`.
- Readiness/liveness: probe `GET /` (200 once web assets are served). The image's Docker `HEALTHCHECK` is ignored by k8s.
- Backup story: back up the PVC (`hapi.db` + keys), not a database server.

## Put it behind a reverse proxy

The hub speaks plain HTTP on `3006`. Terminate TLS in front of it (Caddy/Traefik/nginx/Cloudflare Tunnel) and set:

- `HAPI_PUBLIC_URL` — the externally visible HTTPS URL
- `CORS_ORIGINS` — allowed browser origins, if not same-origin

## Configuration

Runtime configuration is environment-based (same as upstream):

| Variable | Meaning |
| --- | --- |
| `HAPI_PUBLIC_URL` | Public HTTPS origin (proxied) |
| `CORS_ORIGINS` | Allowed CORS origins |
| `CLI_API_TOKEN` | Pre-provision auth token (auto-generated on first boot if unset) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot integration (optional) |
| `DB_PATH` | SQLite path override (default `/data/hapi.db`) |

`HAPI_LISTEN_HOST=0.0.0.0` and `HAPI_HOME=/data` are baked into the image.

## Persistence and the `/data` volume

Everything stateful lives under `/data`:

```text
/data/hapi.db        # SQLite database (sessions, messages, machines)
/data/settings.json  # hub settings
/data/*.pem          # JWT signing keys
/data/vapid.json     # Web Push VAPID keys
```

Bind-mounting a host directory instead of a named volume works, but the directory must be writable by UID 1000.

## Multi-arch builds

CI builds both `linux/amd64` and `linux/arm64` via QEMU + buildx. For a local single-arch build:

```bash
docker build -t hapi-hub .
```

## Publishing via CI

`sync-upstream.yml` (daily + manual dispatch) merges the newest upstream `v*` release tag into this branch and calls `docker.yml`, which publishes `X.Y.Z`, `X.Y`, `X`, and `latest` tags. Failures (merge conflict, rejected push, broken build) open an `upstream-sync` issue that auto-closes on the next success.

It pushes with the **`SYNC_TOKEN` repository secret**: a fine-grained PAT on this repo with `Contents: Read and write` + `Workflows: Read and write`. That permission is not optional — GitHub refuses any `GITHUB_TOKEN` push that creates or updates `.github/workflows/**`, so the first upstream tag that adds or edits a workflow file (e.g. `android-release.yml` in v0.30.x) rejects the sync until the secret exists. Rotate it before the PAT expires.

## Troubleshooting

- **Hub unreachable from outside the container** — `HAPI_LISTEN_HOST` must stay `0.0.0.0` (default in the image).
- **`/data` permission errors** — ensure UID 1000 owns the volume/bind mount.
- **Web app 503** — assets are baked at build time; a 503 from `/` means the image is corrupt or `/data` is read-only.
- **Sync failed with `refusing to allow a GitHub App to create or update workflow ... without \`workflows\` permission`** — `SYNC_TOKEN` is missing, expired, or lacks `Workflows: write`. `permissions: contents: write` cannot fix it: the token needs the Workflows permission. Merges stay on the runner and `main` keeps its old tag until a run pushes successfully.
