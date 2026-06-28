# 1. Expose plannotator through the hub via a Socket.IO reverse tunnel

Date: 2026-06-28

## Status

Proposed — design agreed; not yet implemented. This is the first ADR in this
repository; the format follows [Michael Nygard](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions)
and mirrors `plannotator/adr/`.

## Context

Deployment shape:

- **Hub** runs on a homelab, exposed publicly at `hapi.raenzo.com` (Cloudflare
  Tunnel). It is a Hono server (`hub/src/web/server.ts`) serving a REST/SSE API
  under `/api/*`, an embedded React PWA via a SPA catch-all, Socket.IO on
  `/socket.io/`, and a couple of fixed-upstream voice WebSocket proxies.
- **Runners** (`cli/`) run on multiple dev machines. Each wraps an AI agent and
  connects to the hub as a **Socket.IO client** (`/cli` namespace). The hub
  generally cannot dial into a runner (runners are behind NAT; they connect out).
- The user operates everything from `hapi.raenzo.com` (often phone/remote/AFK).

**plannotator** (`/Users/raincore/clone/plannotator`) is a Bun HTTP server that
runs **on the agent's machine**, tightly coupled to the agent process: on
`ExitPlanMode` it reads the plan from stdin, starts a server on a random port,
serves a review UI, and writes the approve/deny decision back to stdout for the
agent. It also has `review` (code review) and `annotate` modes invoked by agent
slash commands. Today it opens `localhost:<port>` in a browser and has:

- **No base-path support** — every route (`/api/plan`, SSE streams, the
  `/api/agent-terminal/pty/<token>` WebSocket) is served at the root.
- **No auth** on its localhost server.
- Settings persisted in **cookies** (keyed by port, because the port is random
  per invocation).
- Real-time paths that need streaming: SSE (`/api/external-annotations/stream`,
  `/api/ai/query`, `/api/agents/jobs/stream`) and a bidirectional PTY WebSocket.

Goal: reach plannotator at `hapi.raenzo.com/plannotator/<token>` instead of
`localhost:<port>`, and auto-open that public page when the agent triggers it.

### Code facts that shape the design (verified)

- **Hapi already intercepts `ExitPlanMode`.** `cli/src/claude/utils/permissionHandler.ts:260`
  treats `exit_plan_mode`/`ExitPlanMode` as a permission request; on approval it
  injects `PLAN_FAKE_RESTART` and denies the tool call with `PLAN_FAKE_REJECT`
  so the agent continues in the chosen mode. The hub web app renders the plan
  with `web/src/components/ToolCard/views/ExitPlanModeView.tsx` and the decision
  returns via the existing `Permission` RPC. So **hapi already owns the plan
  review event** and has its own (basic) plan UI; plannotator is the *rich*
  version of the same surface — today the two conflict on the same event.
- **The runner already has a local control surface.** `cli/src/runner/controlServer.ts`
  runs a control HTTP server on a persisted `controlPort`; `controlClient.ts`
  already exposes "tell the runner daemon to do X" helpers (e.g.
  `spawnRunnerSession`), authenticated with `hashRunnerCliApiToken`. This is the
  natural IPC channel for a new `registerTunnel` operation.
- **Hub auth is bearer-only** (`hub/src/web/middleware/auth.ts`): it reads
  `Authorization: Bearer <jwt>` (or `?token=` for the SSE stream). There is **no
  auth cookie**. The voice WebSocket passes the JWT via `?token=` because the
  browser cannot set WS headers.
- **The hub has an SPA catch-all** that serves `index.html` for any non-`/api`
  GET — `/plannotator/*` must be carved out before it.
- **Hub↔runner RPC is request/response only.** `hub/src/sync/rpcGateway.ts`
  drives `socket.timeout().emitWithAck('rpc-request', {method, params})` with a
  30s default timeout. This cannot carry SSE or WebSocket traffic — a framed
  duplex tunnel is required.
- **`hub/src/socket/rpcRegistry.ts`** is a clean bidirectional `method ↔ socketId`
  map with `unregisterAll` cleanup on disconnect — the template for a
  `TokenRegistry` (`token ↔ socketId`).
- Socket.IO is TCP-ordered-reliable on a connection (no loss/dup in normal
  operation) but **does not propagate backpressure** to the application — emit
  faster than the link drains and it buffers in memory.

## Decision

Expose plannotator through the hub by **reverse-tunneling its HTTP/WebSocket
traffic over the existing Socket.IO hub↔runner connection**. Concretely:

1. **Transport** — a framed duplex tunnel multiplexed over the runner's single
   `/cli` Socket.IO connection. The hub exposes `/plannotator/<token>/*`; the
   owning runner proxies each stream to `localhost:<port>`.
2. **Scope** — all three plannotator modes (plan review, code review, annotate).
3. **Registration** — a new `hapi tunnel register --port <p> [--mode …] [--label …]`
   CLI subcommand → runner `controlServer` → hub. The runner mints an opaque
   128-bit token, records `token → localhost:port`, tells the hub it owns the
   token, and returns `{ publicUrl }`. plannotator (self-started modes) shells
   out to this on startup and opens the returned URL.
4. **Addressing** — opaque unguessable per-invocation token. No human-readable
   scheme; the hub web UI keeps an "active plannotator sessions" list.
5. **Page form** — standalone full-page route at
   `hapi.raenzo.com/plannotator/<token>` (plannotator is already a full-page app;
   add a runtime base path). No iframe embedding in the chat UI (out of scope).
6. **Auto-open** — both: the hub pushes an SSE event to the web UI (toast +
   open/navigate, primary for the AFK/remote case), and the runner opens the
   public URL locally when a display is present.
7. **Auth** — owner JWT carried in a new **httpOnly auth cookie** (issued at
   login alongside the existing bearer), validated on `/plannotator/*`.
   plannotator stays auth-unaware; the token is for routing only.
8. **plannotator dependency** — **optional with fallback**: if the plannotator
   binary is present on a runner, ExitPlanMode launches plannotator and tunnels
   it; otherwise hapi falls back to the built-in `ExitPlanModeView`.
9. **Plan-review plumbing** — plannotator's approve/deny (+ annotations) is fed
   back through the **existing** `permissionHandler.ts:260` response path;
   `PLAN_FAKE_RESTART` is unchanged.

## Architecture

```
Browser (you, at hapi.raenzo.com)
   │  HTTPS  /plannotator/<token>/<rest>   (+ cookie auth)
   ▼
Hub (homelab, public)
   │  TokenRegistry: token → runner socketId
   │  carve /plannotator/* before SPA catch-all
   │  framed tunnel over the runner's /cli socket
   ▼ (Socket.IO, already-connected, already runner-authenticated)
Runner (dev machine)
   │  token → localhost:<port> map
   │  fetch("http://localhost:<port>/<rest>")  (or local WS for PTY)
   ▼
plannotator server (child of the agent process)
```

Per mode:

- **Plan review** — agent calls `ExitPlanMode` → hapi's permission handler
  detects plannotator on the runner → launches plannotator headless with the
  plan on stdin, under base path → registers the route → the hub's permission UI
  redirects/auto-navigates to `/plannotator/<token>` → user annotates →
  plannotator's stdout decision is returned as the permission `response` at
  `permissionHandler.ts:260`. `PLAN_FAKE_RESTART` is unchanged.
- **Code review / annotate** — agent slash command starts plannotator on the
  runner → plannotator shells out to `hapi tunnel register`, opens the returned
  public URL (runner-local open if a display is present), and the hub emits
  `plannotator:opened` so the web UI can toast/open. The browser reaches the UI
  through the same tunnel.

## Tunnel protocol specification

One bidirectional Socket.IO event `tunnel:frame`. Each browser HTTP/WS request
is one **stream** keyed by a hub-minted `streamId`. Frames are
`[meta, buffer?]` tuples — `meta` is JSON, `buffer` is a raw binary chunk carried
natively by Socket.IO (no base64).

| Direction | Frame | Purpose |
|---|---|---|
| hub→runner | `open {streamId, token, method, path, query, headers, body?}` | start HTTP/WS; inline request body if small |
| hub→runner | `data {streamId, chunk}` | browser→upstream bytes (POST body, browser WS frames) |
| hub→runner | `end {streamId}` / `close {streamId, code?, reason?}` | request body done / client gone |
| runner→hub | `headers {streamId, status, headers, body?, fin?}` | response head; if `body`+`fin` set, the whole response in one frame (opportunistic inline) |
| runner→hub | `data {streamId, chunk}` | response/SSE/WS bytes |
| runner→hub | `end {streamId}` / `close {streamId, code?, reason?}` / `error {streamId, code, msg}` | finished / upstream closed / failed |

**Lifecycle:** browser hits `/plannotator/<token>/<rest>` → hub validates the
auth cookie → looks up `token → socket` (TokenRegistry; missing → 503) → mints
`streamId` → emits `open` → runner `fetch`es `http://localhost:<port>/<rest>`
(or opens a local WS for the PTY) → streams `headers` + `data` back → hub writes
to the browser `Response` / WS. Either side `close`, or a socket disconnect,
tears the stream down. Streams multiplex over the single `/cli` socket.

- **SSE** — a `fetch` whose `Response.body` stays open; the runner keeps emitting
  `data` as chunks arrive; client disconnect → hub `close` → runner aborts.
- **PTY WebSocket** — hub upgrades the browser WS at
  `/plannotator/<token>/api/agent-terminal/pty/<tk>` with
  `{_plannotatorTunnel, token, streamId}` (same upgrade pattern as the existing
  Gemini/Qwen voice proxies in `server.ts`); bridges frames both ways via
  `data`; close codes normalized through the existing `toClientCloseCode`
  (1005/1006/1015 → 1011).

**Backpressure — sliding window + upstream pause.** Each stream has a 256KiB
send window. The sender stops when the window is full; the receiver sends
`ack {streamId, upto}` as it drains. The hub pauses the browser `Response`
writer / WS; the runner pauses the `fetch` `Response.body` ReadableStream (or
the local WS). Bounded memory; survives a fast-upstream/slow-browser link.

**Opportunistic inline small responses.** Runner reads the response body up to
64KiB; if the whole body fits and it is not `text/event-stream`, emit a single
`headers {streamId, status, headers, body, fin:true}` frame. The hub collapses
an inline `headers{body,fin}` uniformly — no separate hub-side path. Collapses
plannotator's many small JSON calls to one frame each.

**Leak prevention.** Mirror `RpcRegistry.unregisterAll`: on runner-socket
disconnect, the hub tears down all that socket's streams and closes the browser
sides (WS 1011, HTTP aborted); on browser disconnect, hub sends `close` and the
runner aborts the upstream. Generous per-stream idle timeout (HTTP ~60s,
SSE/WS ~30min, env-overridable) as a backstop.

**Reconnect.** Runner keeps `token → port` in memory + runner-state; on
Socket.IO reconnect it re-registers all *live* tokens (the hub dropped them on
disconnect). Dead plannotator ports are pruned by the runner's existing
`localhost:port` health-check. No token persistence at the hub (ephemeral).

**Auth boundary.** The auth cookie is validated on `/plannotator/<token>/*`
**before** the tunnel opens; the tunnel then carries an already-authorized
stream. `token → socket` is the hub's own map, so a runner cannot serve another
runner's token (no cross-spoofing). The PTY WS is remote command exec on the
runner, cookie-gated — the same threat model as hapi's existing Terminal
Anywhere.

**Sizing.** 64KiB `data` chunks, 256KiB send window, 64KiB inline cap; honor
`SOCKET_MAX_HTTP_BUFFER_SIZE`; all env-overridable.

**Errors.** `error {streamId, code, msg}` → hub maps to HTTP 502 + closes.
Codes: `upstream-unreachable | upstream-timeout | window-violation | token-unknown`.

**Per-stream state.** Hub `Map<streamId, {token, socketId, browserResp|browserWs, sendWindow, unacked}>`;
runner `Map<streamId, {token, port, fetchController|localWs, sendWindow, unacked}>`.

## Implementation plan (phased)

- **Phase 0 — Hub scaffold.** Carve `/plannotator/*` before the SPA catch-all in
  `createWebApp` (`server.ts`). Issue an httpOnly auth cookie in the auth route;
  accept it in `createAuthMiddleware` alongside bearer. Add `TokenRegistry`
  (`token ↔ socketId`, mirror `RpcRegistry`). Route returns 503 until a tunnel
  exists.
- **Phase 1 — Registry + HTTP-only tunnel (vertical slice).** Runner:
  `controlServer.registerTunnel`; `controlClient.registerTunnel()`;
  `hapi tunnel register` CLI. Hub: on `/plannotator/<token>/<rest>`, look up
  token→socket, mint streamId, frame `open`, stream the `fetch` response back
  with opportunistic inline. plannotator: base-path env + serve; for
  review/annotate, shell `hapi tunnel register` and open the returned URL.
  Disconnect teardown + idle backstop. Proves an end-to-end HTTP round-trip.
- **Phase 2 — Sliding-window backpressure + native binary.** `[meta, buffer]`
  frames; per-stream 256KiB window, acks, upstream pause on both ends.
- **Phase 3 — SSE.** Stream `fetch` `Response.body` for `text/event-stream`;
  long-lived, window-controlled; client disconnect → abort.
- **Phase 4 — WebSocket (PTY).** Hub upgrades browser WS, bridges frames via
  tunnel `data` both ways, close-code mapping via `toClientCloseCode`.
- **Phase 5 — ExitPlanMode integration + auto-open + notifications.** hapi's
  ExitPlanMode path detects the plannotator binary → launches headless (base
  path, plan on stdin) → registers → feeds stdout decision back as the
  permission `response` at `permissionHandler.ts:260`; falls back to
  `ExitPlanModeView` if absent. Hub emits `plannotator:opened` SSE → web UI toast
  + open/navigate; reuse the existing Telegram/push permission pipeline.
  Runner opens the public URL locally if a display is present. plannotator
  removes its own `ExitPlanMode` PermissionRequest hook on hapi-driven agents.
- **Phase 6 — Hardening.** Error→502 mapping; reconnect re-registration;
  heartbeat prune; cookie scoping in plannotator; rate/size limits; PR base-path
  + custom-open-URL upstream to minimize plannotator divergence.

## Changes by repository

**hapi hub (`hub/`)**
- `web/server.ts`: carve `/plannotator/*`; route tunnel traffic; WS upgrade for
  PTY (reuse Gemini/Qwen proxy shape).
- `web/middleware/auth.ts` + `web/routes/auth.ts`: httpOnly auth cookie (issued
  alongside bearer; `SameSite=Lax`).
- `socket/`: `TokenRegistry`; `tunnel:frame` handler; stream-state maps; sliding
  window.
- New SSE event `plannotator:opened`; ExitPlanMode permission UI redirect.

**hapi runner (`cli/`)**
- `runner/controlServer.ts`: `registerTunnel`/`unregister`/heartbeat.
- `runner/controlClient.ts`: `registerTunnel()`; `hapi tunnel register` CLI.
- Tunnel proxy: `fetch`/local-WS to `localhost:<port>`; stream-state; windowing.
- ExitPlanMode path: detect plannotator, launch headless, register, return
  decision as permission response; else built-in fallback.

**plannotator (`packages/server`, `apps/hook`)**
- Base-path support: `PLANNOTATOR_BASE_PATH` threaded through route handlers, the
  single-file HTML (templated at serve), the client `fetch` layer, WS/SSE URLs,
  share base.
- Cookie/storage keyed by token (avoid concurrent-session collision under one
  origin).
- "Hub mode": serve under base path, don't self-open localhost; self-started
  modes shell `hapi tunnel register` and open the returned URL; plan-review (when
  launched by hapi) just serves + emits the decision on stdout.
- Remove plannotator's `ExitPlanMode` PermissionRequest hook on hapi-driven
  agents (avoid the double-handling conflict).

## Risks

- **The framed tunnel is the biggest build + perf risk.** Socket.IO is not a
  bulk byte pipe; every round-trip is browser→hub→socket→runner→localhost and
  back. Sliding-window backpressure + native binary + opportunistic inline are
  the mitigations. Image uploads, large diffs, and PTY bursts are the stress
  cases (especially over a WAN link to a remote runner).
- **plannotator forks from upstream** → ongoing sync cost. The base-path +
  custom-open-URL changes are generally useful and should be PR'd upstream.
- **Cookie auth touches hapi's core auth.** `SameSite=Lax`; bearer-equivalent so
  no new CSRF surface, but it is a change to a security-sensitive path.
- **Remote PTY through the tunnel** = command exec on the runner from the public
  URL (cookie-gated). Consistent with Terminal Anywhere, but worth an explicit
  acknowledgment.

## Alternatives considered

- **Networking-only reverse proxy (per-runner cloudflared/SSH/WireGuard).**
  Rejected: requires a tunnel daemon per runner, separate auth, and doesn't
  generalize to NAT'd/remote runners without each running a tunnel. The Socket.IO
  tunnel is uniform and reuses the existing authenticated link.
- **Integrate plannotator into the hub (absorb its server).** Rejected: would
  require reimplementing plannotator's endpoints/UI on the hub or vendoring its
  React app, and would still need a streaming channel for the PTY — the
  "no-tunnel" advantage evaporates. The proxy keeps plannotator a swappable
  upstream dep.
- **Plan-review only (no code review/annotate).** Rejected as the target: a
  generic registry is needed anyway, and code review is half of plannotator's
  value. (Plan-review ships first as Phase 5 of the same architecture.)
- **Auth via token-as-capability only.** Rejected in favor of cookie-gated JWT:
  tokens leak via browser history/referrer/logs; on a public domain the
  owner-cookie is worth the modest hub change.
- **Auth via injected bearer (plannotator attaches the JWT).** Rejected: pushes
  auth logic into plannotator (the most plannotator surgery) and the JWT still
  touches the URL on first load.
- **plannotator required on every runner.** Rejected: optional + graceful
  fallback to `ExitPlanModeView` fits multi-machine rollouts and keeps a
  lightweight approve/deny path.
- **Backpressure: cap + close-on-overrun.** Rejected: not real flow control; OOM
  or spurious closes under plannotator's image uploads / PTY.
- **Uniform streaming (no inline fast-path).** Rejected: plannotator is chatty
  with small JSON; opportunistic inline collapses those to one frame with near-
  zero added protocol complexity.

## Consequences

- plannotator becomes reachable — and auto-opened — at
  `hapi.raenzo.com/plannotator/<token>`, uniformly across all three modes and
  across all runners (local or remote), behind the owner's auth.
- hapi gains a generic, reusable "tunnel a runner-local HTTP/WS service through
  the hub" capability (TokenRegistry + framed tunnel + `hapi tunnel register`),
  usable beyond plannotator.
- The plan-review surface is enriched (annotations, version diff, code review)
  while the existing ExitPlanMode decision mechanics are reused unchanged.
- Two new cross-repo couplings to maintain: the tunnel contract (hapi↔runner)
  and the plannotator base-path/hub-mode changes (try to upstream the latter).

## Open questions / follow-ups

- Concrete window/chunk tuning once measured on a real remote-runner link.
- Whether to also expose a stable `/plannotator/s/<sessionId>` alias for the
  active plan-review on a given session (nice-to-have; not required).
- Whether the generic tunnel should later carry other runner-local tools
  (decide when a second consumer appears).

## Phase 1 verification (HTTP-only vertical slice)

Phase 1 is implemented across the hapi repo (shared contract + hub + runner +
cli); the plannotator base-path/hub-mode change is task #10 in the separate
plannotator repo.

**Automated coverage (all green, full workspace typecheck clean):**

- Wire contract (`shared/src/tunnel.ts`): `TunnelFrameMeta` discriminated union
  + `tunnel:register`/`tunnel:unregister`/`tunnel:frame` event types on both
  socket maps — shared by both sides, so emitter/parser cannot drift.
- Hub: `HubTunnelStreamManager` round-trips frames → HTTP `Response`
  (503 unknown token, opportunistic inline `headers{fin,buffer}`, streamed
  `headers → data+ → end`, 502 on runner error, teardown on socket disconnect);
  `registerTunnelHandlers` validates frames with zod at the boundary.
- Runner: `RunnerTunnelProxy` fetches `localhost:<port>` with a real local
  server (inline small body, streamed large body, `token-unknown` error),
  streaming the request body when present; `RunnerTunnelRegistry` unit-tested.
- CLI: `parseRegisterArgs` (`hapi tunnel register --port/--mode/--label`).

The hub and runner sides are each tested end-to-end against the shared frame
contract; the live Socket.IO bridge between them is verified by the manual
smoke test below (a cross-package in-process bridge test is awkward in this
workspace — hub and cli are separate packages — and largely re-checks what the
shared types already enforce).

**Live smoke test (homelab):**

1. Start the hub (`hapi hub`) and a runner (`hapi runner start-sync`).
2. On the runner, start any local HTTP server, e.g. `python3 -m http.server 8765`.
3. Register it: `hapi tunnel register --port 8765` → prints
   `https://<hub>/plannotator/<token>`.
4. Fetch the owner auth cookie (log into the hub web UI; copy the `Authorization`
   bearer, or use the cookie set at login).
5. `curl -k -b "hapi_auth=<jwt>" https://<hub>/plannotator/<token>/` returns the
   tunneled directory listing; `curl … /plannotator/<token>` (no trailing slash)
   is also routed to upstream `/`.
6. Stop the runner → a follow-up request returns 503 (token no longer owned).

Phase 2 adds the sliding-window backpressure + acks on top of this frame shape;
SSE (Phase 3) and the PTY WebSocket (Phase 4) reuse the same stream lifecycle.
