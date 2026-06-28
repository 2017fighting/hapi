import type { ServerWebSocket } from 'bun'
import { type TunnelFrameMeta, TUNNEL_DEFAULT_WINDOW_SIZE } from '@hapi/protocol'
import type { CliSocketWithData, SocketServer } from './socketTypes'
import type { TokenRegistry } from './tokenRegistry'

/**
 * Hub-side state for in-flight plannotator tunnel streams. One browser HTTP
 * request to `/plannotator/<token>/*` becomes one stream keyed by a hub-minted
 * `streamId`; the {@link TokenRegistry} resolves the owning runner socket and
 * the manager frames `open` over the existing `/cli` Socket.IO connection, then
 * bridges the runner's `headers`/`data`/`end`/`error` frames back into the HTTP
 * response body. Opportunistic inline (`headers{fin,buffer}`) collapses a whole
 * small response to one frame.
 *
 * Phase 1: no send window / acks (Phase 2). Idle timeout is the only backstop.
 * See adr/0001-plannotator-tunnel.md.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 60_000
/** Response-body send window (env-overridable). Bounds in-flight bytes from the runner. */
const WINDOW_SIZE = resolveEnvNumber('HAPI_TUNNEL_WINDOW_SIZE', TUNNEL_DEFAULT_WINDOW_SIZE)
/** Idle timeout for long-lived event-stream (SSE) responses — generous, since events may be sparse. */
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 30 * 60_000

/** Hop-by-hop and length headers that must not be copied onto the browser response. */
const STRIPPED_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length'
])

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function mintStreamId(): string {
    return crypto.randomUUID()
}

/** Normalize a close code before sending it in a close frame. Codes 1005/1006/1015 are
 *  reserved and cannot be sent; abnormal drops commonly produce 1006, which would throw. */
function toClientCloseCode(code: number): number {
    return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1011
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
            out[key] = value
        }
    }
    return out
}

export interface OpenStreamInput {
    token: string
    method: string
    path: string
    query: string
    headers: Record<string, string>
    body: ReadableStream<Uint8Array> | null
}

interface PendingStream {
    token: string
    socketId: string
    streamId: string
    controller: ReadableStreamDefaultController<Uint8Array>
    resolveHead: (head: { status: number; headers: Record<string, string> }) => void
    rejectHead: (error: Error) => void
    headersDone: boolean
    closed: boolean
    idleTimer: ReturnType<typeof setTimeout>
    idleTimeoutMs: number
    // Phase 2 backpressure: buffer incoming runner bytes, flush to the browser as
    // it drains (pull), and ack the runner for bytes flushed.
    pendingChunks: Uint8Array[]
    pendingBytes: number
    receivedBytes: number
    ackedToRunner: number
}

/** Upgrade `data` attached to a browser PTY WebSocket by `server.ts` (Phase 4). */
export interface PlannotatorTunnelWsData {
    _plannotatorTunnel: true
    token: string
    streamId: string
    /** Upstream path (leading '/') with the `/plannotator/<token>` prefix already stripped. */
    wsPath: string
    /** Raw query string without the leading '?'. */
    wsQuery: string
}

/** Hub-side state for one in-flight PTY WebSocket stream (browser WS ↔ tunnel `data`). */
interface WsStream {
    token: string
    socketId: string
    streamId: string
    ws: ServerWebSocket<PlannotatorTunnelWsData>
    closed: boolean
    idleTimer: ReturnType<typeof setTimeout>
    idleTimeoutMs: number
}

export class HubTunnelStreamManager {
    private readonly streams = new Map<string, PendingStream>()
    private readonly wsStreams = new Map<string, WsStream>()
    private readonly idleTimeoutMs: number
    private readonly sseIdleTimeoutMs: number

    constructor(
        private readonly io: SocketServer,
        private readonly tokenRegistry: TokenRegistry,
        options: { idleTimeoutMs?: number } = {}
    ) {
        this.idleTimeoutMs = options.idleTimeoutMs ?? resolveEnvNumber('HAPI_TUNNEL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
        this.sseIdleTimeoutMs = resolveEnvNumber('HAPI_TUNNEL_SSE_IDLE_TIMEOUT_MS', DEFAULT_SSE_IDLE_TIMEOUT_MS)
    }

    /**
     * Open a tunnel stream for one browser HTTP request. Looks up the owning
     * runner, frames `open`, awaits the runner's `headers`, and returns a
     * `Response` whose body is bridged from subsequent frames. Returns 503 if no
     * runner owns the token, 502 if the runner errors or times out.
     */
    async openStream(input: OpenStreamInput): Promise<Response> {
        const socketId = this.tokenRegistry.getSocketIdForToken(input.token)
        if (!socketId) {
            return new Response('plannotator tunnel not available', { status: 503 })
        }
        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            return new Response('plannotator tunnel not available', { status: 503 })
        }

        const streamId = mintStreamId()
        let controller!: ReadableStreamDefaultController<Uint8Array>
        let pending!: PendingStream
        const body = new ReadableStream<Uint8Array>(
            {
                start: (c) => {
                    controller = c
                },
                pull: () => {
                    // Browser drained queued bytes — flush more from the buffer + ack the runner.
                    this.flushPending(pending)
                },
                cancel: () => {
                    // Browser went away — tell the runner to abort the upstream.
                    this.sendFrame(socketId, { type: 'close', streamId })
                    this.closeStream(streamId)
                }
            },
            new ByteLengthQueuingStrategy({ highWaterMark: WINDOW_SIZE })
        )

        let resolveHead!: PendingStream['resolveHead']
        let rejectHead!: PendingStream['rejectHead']
        const headPromise = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
            resolveHead = resolve
            rejectHead = reject
        })

        pending = {
            token: input.token,
            socketId,
            streamId,
            controller,
            resolveHead,
            rejectHead,
            headersDone: false,
            closed: false,
            idleTimer: setTimeout(() => this.timeoutStream(streamId), this.idleTimeoutMs),
            idleTimeoutMs: this.idleTimeoutMs,
            pendingChunks: [],
            pendingBytes: 0,
            receivedBytes: 0,
            ackedToRunner: 0
        }
        this.streams.set(streamId, pending)

        const openMeta: TunnelFrameMeta = {
            type: 'open',
            streamId,
            token: input.token,
            method: input.method,
            path: input.path,
            query: input.query,
            headers: input.headers,
            hasBody: input.body !== null
        }
        socket.emit('tunnel:frame', openMeta)

        if (input.body) {
            void this.pipeRequestBody(streamId, socketId, input.body)
        }

        try {
            const head = await headPromise
            return new Response(body, { status: head.status, headers: sanitizeResponseHeaders(head.headers) })
        } catch {
            this.closeStream(streamId)
            return new Response('plannotator tunnel upstream error', { status: 502 })
        }
    }

    /** Route an incoming runner `tunnel:frame` to its pending browser stream. */
    handleFrame(socket: CliSocketWithData, meta: TunnelFrameMeta, buffer?: Uint8Array): void {
        const pending = this.streams.get(meta.streamId)
        if (!pending) {
            // Not an HTTP stream — maybe a PTY WebSocket stream (Phase 4).
            const wsStream = this.wsStreams.get(meta.streamId)
            if (wsStream) {
                if (wsStream.socketId !== socket.id) {
                    return
                }
                this.handleWsFrame(wsStream, meta, buffer)
            }
            return
        }
        // A runner may only serve its own streams (no cross-spoofing).
        if (pending.socketId !== socket.id) {
            return
        }
        this.bumpIdle(meta.streamId)

        switch (meta.type) {
            case 'headers': {
                pending.headersDone = true
                pending.resolveHead({ status: meta.status, headers: meta.headers })
                // Long-lived SSE responses get a much larger idle window (events may be sparse).
                if ((meta.headers['content-type'] ?? '').includes('text/event-stream')) {
                    pending.idleTimeoutMs = this.sseIdleTimeoutMs
                    this.bumpIdle(meta.streamId)
                }
                if (meta.fin && buffer && !pending.closed) {
                    pending.receivedBytes += buffer.byteLength
                    pending.pendingChunks.push(buffer)
                    pending.pendingBytes += buffer.byteLength
                    this.flushPending(pending)
                    pending.controller.close()
                    pending.closed = true
                    this.closeStream(meta.streamId)
                }
                return
            }
            case 'data': {
                if (buffer && !pending.closed) {
                    pending.receivedBytes += buffer.byteLength
                    pending.pendingChunks.push(buffer)
                    pending.pendingBytes += buffer.byteLength
                    this.flushPending(pending)
                }
                return
            }
            case 'end': {
                if (!pending.closed) {
                    pending.controller.close()
                    pending.closed = true
                }
                this.closeStream(meta.streamId)
                return
            }
            case 'close': {
                this.closeStream(meta.streamId)
                return
            }
            case 'error': {
                if (!pending.headersDone) {
                    pending.rejectHead(new Error(meta.msg))
                }
                this.closeStream(meta.streamId)
                return
            }
            default: {
                return
            }
        }
    }

    /** Tear down every stream owned by a runner socket that just disconnected. */
    teardownSocket(socketId: string): void {
        for (const streamId of this.streams.keys()) {
            const pending = this.streams.get(streamId)
            if (pending?.socketId === socketId) {
                if (!pending.headersDone) {
                    pending.rejectHead(new Error('runner-socket-disconnected'))
                }
                this.closeStream(streamId)
            }
        }
        for (const streamId of this.wsStreams.keys()) {
            const stream = this.wsStreams.get(streamId)
            if (stream?.socketId === socketId) {
                try { stream.ws.close(1011, 'runner disconnected') } catch { /* client gone */ }
                this.closeWsStream(streamId)
            }
        }
    }

    // ─── PTY WebSocket streams (Phase 4) ───────────────────────────────────────
    // Called from the Bun `websocket` dispatch in server.ts. The browser WS was upgraded
    // (cookie-authenticated) with {_plannotatorTunnel, token, streamId, wsPath, wsQuery};
    // these methods bridge it to the owning runner over tunnel `data` frames.

    /** A browser PTY WS opened: resolve the owning runner, register the stream, emit `open{mode:'ws'}`. */
    onBrowserWsOpen(ws: ServerWebSocket<PlannotatorTunnelWsData>): void {
        const { token, streamId, wsPath, wsQuery } = ws.data
        const socketId = this.tokenRegistry.getSocketIdForToken(token)
        if (!socketId || !this.io.of('/cli').sockets.get(socketId)) {
            try { ws.close(1011, 'plannotator tunnel not available') } catch { /* client gone */ }
            return
        }
        this.wsStreams.set(streamId, {
            token,
            socketId,
            streamId,
            ws,
            closed: false,
            idleTimer: setTimeout(() => this.timeoutWsStream(streamId), this.sseIdleTimeoutMs),
            idleTimeoutMs: this.sseIdleTimeoutMs
        })
        this.sendFrame(socketId, {
            type: 'open',
            streamId,
            token,
            method: 'GET',
            path: wsPath,
            query: wsQuery,
            headers: {},
            hasBody: false,
            mode: 'ws'
        })
    }

    /** browser → runner: forward a PTY WS frame to the owning runner as a tunnel `data` frame. */
    onBrowserWsMessage(ws: ServerWebSocket<PlannotatorTunnelWsData>, data: string | ArrayBuffer | Uint8Array): void {
        const streamId = ws.data.streamId
        const stream = this.wsStreams.get(streamId)
        if (!stream || stream.closed) {
            return
        }
        this.bumpWsIdle(streamId)
        const text = typeof data === 'string'
            ? data
            : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
        // Browser→runner PTY input (keystrokes) is tiny and bursty; left unwindowed (Phase 6 candidate).
        this.sendFrame(stream.socketId, { type: 'data', streamId }, new TextEncoder().encode(text))
    }

    /** The browser closed the PTY WS: tell the runner to abort the upstream and drop the stream. */
    onBrowserWsClose(ws: ServerWebSocket<PlannotatorTunnelWsData>, code: number | undefined, reason: string | undefined): void {
        const streamId = ws.data.streamId
        const stream = this.wsStreams.get(streamId)
        if (!stream) {
            return
        }
        this.sendFrame(stream.socketId, { type: 'close', streamId, code, reason })
        this.closeWsStream(streamId)
    }

    /** Route a runner frame for a PTY WS stream to the browser WS. */
    private handleWsFrame(stream: WsStream, meta: TunnelFrameMeta, buffer?: Uint8Array): void {
        this.bumpWsIdle(stream.streamId)
        switch (meta.type) {
            case 'data': {
                if (buffer && !stream.closed && stream.ws.readyState === 1 /* OPEN */) {
                    try { stream.ws.send(new TextDecoder().decode(buffer)) } catch { /* client gone */ }
                }
                return
            }
            case 'close': {
                try { stream.ws.close(toClientCloseCode(meta.code ?? 1000), (meta.reason ?? 'upstream closed').slice(0, 123)) } catch { /* client gone */ }
                this.closeWsStream(stream.streamId)
                return
            }
            case 'end': {
                try { stream.ws.close(1000, 'upstream closed') } catch { /* client gone */ }
                this.closeWsStream(stream.streamId)
                return
            }
            case 'error': {
                try { stream.ws.close(1011, 'upstream error') } catch { /* client gone */ }
                this.closeWsStream(stream.streamId)
                return
            }
            default: {
                return
            }
        }
    }

    private bumpWsIdle(streamId: string): void {
        const stream = this.wsStreams.get(streamId)
        if (!stream) {
            return
        }
        clearTimeout(stream.idleTimer)
        stream.idleTimer = setTimeout(() => this.timeoutWsStream(streamId), stream.idleTimeoutMs)
    }

    private timeoutWsStream(streamId: string): void {
        const stream = this.wsStreams.get(streamId)
        if (!stream) {
            return
        }
        try { stream.ws.close(1011, 'idle timeout') } catch { /* client gone */ }
        this.closeWsStream(streamId)
    }

    private closeWsStream(streamId: string): void {
        const stream = this.wsStreams.get(streamId)
        if (!stream) {
            return
        }
        clearTimeout(stream.idleTimer)
        stream.closed = true
        this.wsStreams.delete(streamId)
    }

    private bumpIdle(streamId: string): void {
        const pending = this.streams.get(streamId)
        if (!pending) {
            return
        }
        clearTimeout(pending.idleTimer)
        pending.idleTimer = setTimeout(() => this.timeoutStream(streamId), pending.idleTimeoutMs)
    }

    private timeoutStream(streamId: string): void {
        const pending = this.streams.get(streamId)
        if (!pending) {
            return
        }
        if (!pending.headersDone) {
            pending.rejectHead(new Error('idle-timeout'))
        }
        this.closeStream(streamId)
    }

    /**
     * Move buffered runner bytes into the browser Response controller while the
     * browser is draining (pull), and ack the runner for bytes handed off so its
     * send window advances. Stops when the controller is saturated (backpressure).
     */
    private flushPending(pending: PendingStream): void {
        if (pending.closed) {
            return
        }
        while (pending.pendingChunks.length > 0) {
            const next = pending.pendingChunks[0]
            const desired = pending.controller.desiredSize
            if (desired !== null && desired < next.byteLength) {
                break
            }
            pending.pendingChunks.shift()
            pending.controller.enqueue(next)
            pending.pendingBytes -= next.byteLength
        }
        const ackUpto = pending.receivedBytes - pending.pendingBytes
        if (ackUpto > pending.ackedToRunner) {
            pending.ackedToRunner = ackUpto
            this.sendFrame(pending.socketId, { type: 'ack', streamId: pending.streamId, upto: ackUpto })
        }
    }

    private closeStream(streamId: string): void {
        const pending = this.streams.get(streamId)
        if (!pending) {
            return
        }
        clearTimeout(pending.idleTimer)
        if (!pending.closed) {
            try {
                pending.controller.close()
            } catch {
                // Controller may already be closed; ignore.
            }
            pending.closed = true
        }
        this.streams.delete(streamId)
    }

    private sendFrame(socketId: string, meta: TunnelFrameMeta, buffer?: Uint8Array): void {
        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            return
        }
        if (buffer) {
            socket.emit('tunnel:frame', meta, buffer)
        } else {
            socket.emit('tunnel:frame', meta)
        }
    }

    private async pipeRequestBody(streamId: string, socketId: string, body: ReadableStream<Uint8Array>): Promise<void> {
        const reader = body.getReader()
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                if (value) {
                    this.sendFrame(socketId, { type: 'data', streamId }, value)
                }
            }
            this.sendFrame(socketId, { type: 'end', streamId })
        } catch {
            this.sendFrame(socketId, { type: 'close', streamId })
        } finally {
            try {
                reader.releaseLock()
            } catch {
                // Ignore.
            }
        }
    }
}
