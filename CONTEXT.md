# hapi fork (2017fighting/hapi)

A deployment-oriented fork of upstream hapi: we mirror upstream code verbatim and add only the Docker image publishing machinery for our k8s deployment.

## Language

**Upstream**:
tiann/hapi — the authoritative source of all hub/cli/web/shared code in this repo. We never edit it.
_Avoid_: origin (that is our fork's remote), base repo

**Overlay**:
The only fork-owned content on `main`: `Dockerfile`, `.dockerignore`, `docker.yml`, `sync-upstream.yml`, `docs/guide/docker.md`. Everything else on `main` is verbatim upstream.
_Avoid_: patches, fork changes, PG branch

**Tag sync**:
The daily CI job that merges the newest upstream `v*` tag into `main` and publishes the version image. Nothing but tags is ever merged.
_Avoid_: main sync (the failed PG-era daily merge of upstream HEAD)

**Version image**:
`ghcr.io/2017fighting/hapi-hub:vX.Y.Z` — the deployment unit. The k8s manifest pins one and an automation bumps it when new tags appear.
_Avoid_: rolling image, `:main` (retired; no longer published)

**PG archive**:
The frozen branch `postgres` — the abandoned SQLite→PostgreSQL port, kept for reference only.
_Avoid_: main, the fork (the fork is the overlay, not the port)
