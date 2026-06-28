import { type TunnelFrameMeta } from '@hapi/protocol'
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
    controller: ReadableStreamDefaultController<Uint8Array>
    resolveHead: (head: { status: number; headers: Record<string, string> }) => void
    rejectHead: (error: Error) => void
    headersDone: boolean
    closed: boolean
    idleTimer: ReturnType<typeof setTimeout>
}

export class HubTunnelStreamManager {
    private readonly streams = new Map<string, PendingStream>()
    private readonly idleTimeoutMs: number

    constructor(
        private readonly io: SocketServer,
        private readonly tokenRegistry: TokenRegistry,
        options: { idleTimeoutMs?: number } = {}
    ) {
        this.idleTimeoutMs = options.idleTimeoutMs ?? resolveEnvNumber('HAPI_TUNNEL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
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
        const body = new ReadableStream<Uint8Array>({
            start: (c) => {
                controller = c
            },
            cancel: () => {
                // Browser went away — tell the runner to abort the upstream.
                this.sendFrame(socketId, { type: 'close', streamId })
                this.closeStream(streamId)
            }
        })

        let resolveHead!: PendingStream['resolveHead']
        let rejectHead!: PendingStream['rejectHead']
        const headPromise = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
            resolveHead = resolve
            rejectHead = reject
        })

        const pending: PendingStream = {
            token: input.token,
            socketId,
            controller,
            resolveHead,
            rejectHead,
            headersDone: false,
            closed: false,
            idleTimer: setTimeout(() => this.timeoutStream(streamId), this.idleTimeoutMs)
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
                if (meta.fin && buffer && !pending.closed) {
                    pending.controller.enqueue(buffer)
                    pending.controller.close()
                    pending.closed = true
                    this.closeStream(meta.streamId)
                }
                return
            }
            case 'data': {
                if (buffer && !pending.closed) {
                    pending.controller.enqueue(buffer)
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
    }

    private bumpIdle(streamId: string): void {
        const pending = this.streams.get(streamId)
        if (!pending) {
            return
        }
        clearTimeout(pending.idleTimer)
        pending.idleTimer = setTimeout(() => this.timeoutStream(streamId), this.idleTimeoutMs)
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
