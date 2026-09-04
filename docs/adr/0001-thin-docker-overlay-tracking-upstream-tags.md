# Ship upstream-faithful Docker images via a thin overlay branch; abandon the PG port

The fork's `main` carried a full SQLite→PostgreSQL port of the hub (104 files, ±14k lines). Upstream moved 537 commits and the daily auto-merge never succeeded — the port was unmaintainable. Our deployment (k8s, image pull) never needed PG; it needs a Docker image of *upstream* code.

Decision: cut a new `main` from upstream tag `v0.29.0` carrying only the Docker overlay (Dockerfile, image-publish workflow, tag-sync workflow, docker guide — all de-PG'd). A daily CI job merges the newest upstream `v*` tag into `main` and publishes `ghcr.io/2017fighting/hapi-hub:vX.Y.Z` (+ `:latest`). `:main` is retired. The PG branch is archived as `postgres`; its data is discarded — the hub runs upstream SQLite in the existing `/data` PVC, single replica. No PR to upstream: the thin branch is the end state, not a stopgap.

## Considered Options

- **PR Docker support to upstream** — rejected: we don't want to maintain it socially; the overlay gives full control at near-zero merge cost.
- **Rebase or build-time overlay instead of merge** — rejected: force-pushed history makes tags/CI semantics unstable; plain merges of files upstream never touches cannot conflict.
- **Sync upstream `main` HEAD instead of tags** — rejected: untagged churn; tags are the cadence we actually deploy at.

## Consequences

- Hub behavior is exactly upstream (SQLite); fork adds zero product code. Backups moved from Postgres dumps to the `/data` PVC.
- Rollback = pin the k8s manifest to an older version tag; the last PG image stays available as `:v0.20.2-pg.4`.
- Inherited upstream workflows (ios/android/webapp/fixtures/bots) must stay disabled in the fork's Actions settings — they are path-triggered by upstream code we merge but can never pass on the fork.
- A genuinely breaking upstream tag lands automatically; the risk gate is manual rollback, which k8s makes cheap.
