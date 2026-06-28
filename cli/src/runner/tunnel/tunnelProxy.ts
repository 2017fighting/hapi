import type { Socket } from 'socket.io-client'
import { TunnelFrameMetaSchema, type TunnelFrameMeta, TunnelSendWindow, TUNNEL_DEFAULT_WINDOW_SIZE } from '@hapi/protocol'
import { logger } from '@/ui/logger'
import type { RunnerTunnelRegistry } from './runnerTunnelRegistry'

/** Bodies at or below this size are collapsed into a single inline `headers{fin,buffer}` frame. */
const INLINE_CAP_BYTES = 64 * 1024
/** Max bytes per `data` frame (adr/0001 sizing). Splitting upstream chunks bounds frame size + makes the send window effective. */
const CHUNK_SIZE = 64 * 1024

function resolveWindowSize(): number {
    const raw = process.env.HAPI_TUNNEL_WINDOW_SIZE
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : TUNNEL_DEFAULT_WINDOW_SIZE
}

/** Per-direction send window (env-overridable). Bounds in-flight response bytes. */
const WINDOW_SIZE = resolveWindowSize()

interface RunnerStream {
    token: string
    port: number
    abort: AbortController
    reqBodyController: ReadableStreamDefaultController<Uint8Array> | null
    reqBodyClosed: boolean
    respWindow: TunnelSendWindow
}

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
    let length = 0
    for (const chunk of chunks) {
        length += chunk.byteLength
    }
    const out = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

/**
 * Runner-side proxy that bridges hub `tunnel:frame` streams to a local
 * `localhost:<port>` upstream (the plannotator server). On `open` it fetches the
 * upstream — streaming the request body if the browser sent one — and streams the
 * response back, collapsing small bodies into one opportunistic inline frame.
 * Attached to the ApiMachine socket on connect; detached on disconnect, which
 * aborts every in-flight upstream fetch. Phase 1: no send window / acks.
 * See adr/0001-plannotator-tunnel.md.
 */
export class RunnerTunnelProxy {
    private socket: Socket | null = null
    private readonly streams = new Map<string, RunnerStream>()

    constructor(private readonly registry: RunnerTunnelRegistry) {}

    attach(socket: Socket): void {
        this.socket = socket
        socket.on('tunnel:frame', this.onFrame)
    }

    detach(): void {
        if (this.socket) {
            this.socket.off('tunnel:frame', this.onFrame)
            this.socket = null
        }
        for (const streamId of Array.from(this.streams.keys())) {
            this.abortStream(streamId)
        }
    }

    private onFrame = (meta: unknown, buffer?: Uint8Array): void => {
        const parsed = TunnelFrameMetaSchema.safeParse(meta)
        if (!parsed.success) {
            return
        }
        const frame = parsed.data
        switch (frame.type) {
            case 'open':
                void this.onOpen(frame).catch((error) => {
                    logger.debug('[TUNNEL] open frame failed', error)
                })
                return
            case 'data':
                this.onRequestData(frame.streamId, buffer)
                return
            case 'end':
                this.onRequestEnd(frame.streamId)
                return
            case 'close':
                this.abortStream(frame.streamId)
                return
            case 'ack':
                this.onAck(frame.streamId, frame.upto)
                return
            default:
                return
        }
    }

    private async onOpen(frame: Extract<TunnelFrameMeta, { type: 'open' }>): Promise<void> {
        const entry = this.registry.get(frame.token)
        if (!entry) {
            this.emit({ type: 'error', streamId: frame.streamId, code: 'token-unknown', msg: `no tunnel registered for token ${frame.token.slice(0, 8)}` })
            return
        }

        const url = `http://127.0.0.1:${entry.port}${frame.path || '/'}${frame.query ? `?${frame.query}` : ''}`
        const abort = new AbortController()
        let reqBodyController: ReadableStreamDefaultController<Uint8Array> | null = null
        let body: ReadableStream<Uint8Array> | undefined
        if (frame.hasBody) {
            body = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    reqBodyController = controller
                }
            })
        }

        this.streams.set(frame.streamId, {
            token: frame.token,
            port: entry.port,
            abort,
            reqBodyController,
            reqBodyClosed: false,
            respWindow: new TunnelSendWindow(WINDOW_SIZE)
        })

        const init: RequestInit & { duplex?: 'half' } = {
            method: frame.method,
            headers: frame.headers,
            signal: abort.signal
        }
        if (body) {
            init.body = body
            init.duplex = 'half'
        }

        try {
            const response = await fetch(url, init)
            await this.streamResponse(frame.streamId, response)
        } catch (error) {
            if (!abort.signal.aborted) {
                this.emit({ type: 'error', streamId: frame.streamId, code: 'upstream-unreachable', msg: error instanceof Error ? error.message : String(error) })
            }
        } finally {
            this.cleanupStream(frame.streamId)
        }
    }

    private async streamResponse(streamId: string, response: Response): Promise<void> {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
            headers[key] = value
        })
        const isEventStream = (headers['content-type'] ?? '').includes('text/event-stream')
        const body = response.body

        if (!body) {
            this.emit({ type: 'headers', streamId, status: response.status, headers, fin: true })
            return
        }

        const reader = body.getReader()
        const sendWindow = this.streams.get(streamId)?.respWindow
        const buffered: Uint8Array[] = []
        let bufferedSize = 0
        let canInline = !isEventStream

        // Opportunistic inline: keep reading while the whole body still fits the cap.
        while (canInline) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            if (value) {
                buffered.push(value)
                bufferedSize += value.byteLength
                if (bufferedSize > INLINE_CAP_BYTES) {
                    canInline = false
                }
            }
        }

        if (canInline && bufferedSize <= INLINE_CAP_BYTES) {
            const inlineBody = buffered.length > 0 ? concatBytes(buffered) : undefined
            if (sendWindow && inlineBody) {
                await sendWindow.waitForRoom(inlineBody.byteLength)
                sendWindow.recordSent(inlineBody.byteLength)
            }
            this.emit({ type: 'headers', streamId, status: response.status, headers, fin: true }, inlineBody)
            return
        }

        // Too large (or an event stream): flush the buffered prefix, then stream the rest.
        this.emit({ type: 'headers', streamId, status: response.status, headers })
        for (const chunk of buffered) {
            await this.emitDataChunked(streamId, chunk, sendWindow)
        }
        for (;;) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            if (value) {
                await this.emitDataChunked(streamId, value, sendWindow)
            }
        }
        this.emit({ type: 'end', streamId })
    }

    /** Emit a (possibly large) upstream chunk as ≤ CHUNK_SIZE `data` frames, each through the send window. */
    private async emitDataChunked(streamId: string, chunk: Uint8Array, sendWindow: TunnelSendWindow | undefined): Promise<void> {
        let offset = 0
        while (offset < chunk.byteLength) {
            const end = Math.min(offset + CHUNK_SIZE, chunk.byteLength)
            const piece = chunk.subarray(offset, end)
            if (sendWindow) {
                await sendWindow.waitForRoom(piece.byteLength)
                sendWindow.recordSent(piece.byteLength)
            }
            this.emit({ type: 'data', streamId }, piece)
            offset = end
        }
    }

    private onAck(streamId: string, upto: number): void {
        this.streams.get(streamId)?.respWindow.applyAck(upto)
    }

    private onRequestData(streamId: string, buffer?: Uint8Array): void {
        const stream = this.streams.get(streamId)
        if (!stream?.reqBodyController || stream.reqBodyClosed || !buffer) {
            return
        }
        stream.reqBodyController.enqueue(buffer)
    }

    private onRequestEnd(streamId: string): void {
        const stream = this.streams.get(streamId)
        if (!stream?.reqBodyController || stream.reqBodyClosed) {
            return
        }
        try {
            stream.reqBodyController.close()
        } catch {
            // Already closed; ignore.
        }
        stream.reqBodyClosed = true
    }

    private abortStream(streamId: string): void {
        const stream = this.streams.get(streamId)
        if (!stream) {
            return
        }
        try {
            stream.abort.abort()
        } catch {
            // Ignore.
        }
        if (stream.reqBodyController && !stream.reqBodyClosed) {
            try {
                stream.reqBodyController.error(new Error('tunnel-closed'))
            } catch {
                // Ignore.
            }
            stream.reqBodyClosed = true
        }
        this.streams.delete(streamId)
    }

    private cleanupStream(streamId: string): void {
        const stream = this.streams.get(streamId)
        if (!stream) {
            return
        }
        if (stream.reqBodyController && !stream.reqBodyClosed) {
            try {
                stream.reqBodyController.close()
            } catch {
                // Ignore.
            }
            stream.reqBodyClosed = true
        }
        this.streams.delete(streamId)
    }

    private emit(meta: TunnelFrameMeta, buffer?: Uint8Array): void {
        this.socket?.emit('tunnel:frame', meta, buffer)
    }
}
