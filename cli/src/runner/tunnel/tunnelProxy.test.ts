import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { RunnerTunnelRegistry } from './runnerTunnelRegistry'
import { RunnerTunnelProxy, type TunnelWebSocketCtor } from './tunnelProxy'

const TOKEN = '0123456789abcdef0123456789abcdef'

interface Emitted {
    meta: { type: string; streamId?: string; status?: number; fin?: boolean; code?: string }
    buffer?: Uint8Array
}

interface FakeSocket {
    on: (event: string, handler: (...args: unknown[]) => void) => void
    off: (event: string, handler: (...args: unknown[]) => void) => void
    emit: (...args: unknown[]) => void
}

function makeSocket(): { socket: FakeSocket; frames: Emitted[]; done: Promise<void> } {
    const frames: Emitted[] = []
    let resolve!: () => void
    const done = new Promise<void>((r) => {
        resolve = r
    })
    const socket: FakeSocket = {
        on: () => {},
        off: () => {},
        emit: (...args: unknown[]) => {
            const meta = args[1] as Emitted['meta']
            frames.push({ meta, buffer: args[2] as Uint8Array | undefined })
            if (meta?.type === 'end' || (meta?.type === 'headers' && meta?.fin) || meta?.type === 'error') {
                resolve()
            }
        }
    }
    return { socket, frames, done }
}

function openFrame(streamId: string, path: string): unknown {
    return { type: 'open', streamId, token: TOKEN, method: 'GET', path, query: '', headers: {}, hasBody: false }
}

describe('RunnerTunnelProxy', () => {
    let server: ReturnType<typeof Bun.serve>
    let port: number

    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            fetch: (req) => {
                const pathname = new URL(req.url).pathname
                if (pathname === '/big') {
                    return new Response('x'.repeat(100_000))
                }
                return new Response(`hello${pathname}`)
            }
        })
        port = server.port!
    })

    afterAll(() => server.stop())

    it('inlines a small upstream response as headers{fin,buffer}', async () => {
        const registry = new RunnerTunnelRegistry()
        registry.register(TOKEN, { port, createdAt: 0 })
        const { socket, frames, done } = makeSocket()
        const proxy = new RunnerTunnelProxy(registry)
        proxy.attach(socket as never)

        ;(proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame(openFrame('s1', '/plan'))

        await done

        const headersFrame = frames.find((f) => f.meta.type === 'headers')
        expect(headersFrame?.meta.status).toBe(200)
        expect(headersFrame?.meta.fin).toBe(true)
        expect(new TextDecoder().decode(headersFrame?.buffer)).toBe('hello/plan')
    })

    it('streams a large upstream response as headers → data+ → end', async () => {
        const registry = new RunnerTunnelRegistry()
        registry.register(TOKEN, { port, createdAt: 0 })
        const { socket, frames, done } = makeSocket()
        const proxy = new RunnerTunnelProxy(registry)
        proxy.attach(socket as never)

        ;(proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame(openFrame('s2', '/big'))

        await done

        const headersFrame = frames.find((f) => f.meta.type === 'headers')
        expect(headersFrame?.meta.fin).toBeUndefined()
        const total = frames.filter((f) => f.meta.type === 'data').reduce((n, f) => n + (f.buffer?.byteLength ?? 0), 0)
        expect(total).toBe(100_000)
        expect(frames.some((f) => f.meta.type === 'end')).toBe(true)
    })

    it('emits a token-unknown error for an unregistered token', async () => {
        const registry = new RunnerTunnelRegistry()
        const { socket, frames, done } = makeSocket()
        const proxy = new RunnerTunnelProxy(registry)
        proxy.attach(socket as never)

        ;(proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame(openFrame('s3', '/'))

        await done

        const errorFrame = frames.find((f) => f.meta.type === 'error')
        expect(errorFrame?.meta.code).toBe('token-unknown')
    })
})

describe('RunnerTunnelProxy — WebSocket streams (mode: "ws")', () => {
    // A deterministic fake upstream WebSocket, injected via the proxy ctor. Echoes text
    // frames as `echo:<text>` and closes with code 1000 on `close-me`. Stands in for
    // plannotator's `/api/agent-terminal/pty/<tk>` WS — no real Bun.serve, so no teardown hang.
    const created: FakeWebSocket[] = []

    class FakeWebSocket {
        static readonly OPEN = 1
        readonly received: string[] = []
        readyState = 0 // CONNECTING until the handshake microtask flips it to OPEN
        onopen: (() => void) | null = null
        onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null
        onclose: ((event: { code: number; reason: string }) => void) | null = null
        onerror: (() => void) | null = null
        constructor(public readonly url: string) {
            created.push(this)
            queueMicrotask(() => {
                this.readyState = FakeWebSocket.OPEN
                this.onopen?.()
            })
        }
        send(data: string | ArrayBuffer | Uint8Array): void {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
            this.received.push(text)
            if (text === 'close-me') {
                queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'done' }))
                return
            }
            queueMicrotask(() => this.onmessage?.({ data: `echo:${text}` }))
        }
        close(): void {
            this.readyState = 3 // CLOSED
        }
    }

    beforeEach(() => {
        created.length = 0
    })

    async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
        const start = Date.now()
        while (!predicate()) {
            if (Date.now() - start > timeoutMs) {
                throw new Error('waitFor timed out')
            }
            await Bun.sleep(5)
        }
    }

    function makeWsSocket(): { socket: FakeSocket; frames: Emitted[] } {
        const frames: Emitted[] = []
        const socket: FakeSocket = {
            on: () => {},
            off: () => {},
            emit: (...args: unknown[]) => {
                frames.push({ meta: args[1] as Emitted['meta'], buffer: args[2] as Uint8Array | undefined })
            }
        }
        return { socket, frames }
    }

    function wsOpenFrame(streamId: string, path: string): unknown {
        return { type: 'open', streamId, token: TOKEN, method: 'GET', path, query: '', headers: {}, hasBody: false, mode: 'ws' }
    }

    it('opens a local WS and bridges data both directions (echo round-trip)', async () => {
        const registry = new RunnerTunnelRegistry()
        registry.register(TOKEN, { port: 1, createdAt: 0 })
        const { socket, frames } = makeWsSocket()
        const proxy = new RunnerTunnelProxy(registry, FakeWebSocket as unknown as TunnelWebSocketCtor)
        proxy.attach(socket as never)
        const onFrame = (proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame

        onFrame(wsOpenFrame('w1', '/api/agent-terminal/pty/abc'))

        // Runner opened a local WS upstream.
        await waitFor(() => created.length === 1)

        // browser → runner: a tunnel `data` frame reaches the local WS upstream.
        onFrame({ type: 'data', streamId: 'w1' }, new TextEncoder().encode('ping'))
        await waitFor(() => created[0]?.received.includes('ping'))

        // runner → hub: the upstream echo comes back as a tunnel `data` frame.
        await waitFor(() => frames.some((f) => f.meta.type === 'data'))
        const dataFrame = frames.find((f) => f.meta.type === 'data')
        expect(new TextDecoder().decode(dataFrame?.buffer)).toBe('echo:ping')

        // cleanup
        onFrame({ type: 'close', streamId: 'w1' })
    })

    it('maps an upstream-initiated close to a tunnel close frame', async () => {
        const registry = new RunnerTunnelRegistry()
        registry.register(TOKEN, { port: 1, createdAt: 0 })
        const { socket, frames } = makeWsSocket()
        const proxy = new RunnerTunnelProxy(registry, FakeWebSocket as unknown as TunnelWebSocketCtor)
        proxy.attach(socket as never)
        const onFrame = (proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame

        onFrame(wsOpenFrame('w2', '/api/agent-terminal/pty/abc'))
        await waitFor(() => created.length === 1)

        // Upstream closes on receiving `close-me`.
        onFrame({ type: 'data', streamId: 'w2' }, new TextEncoder().encode('close-me'))
        await waitFor(() => frames.some((f) => f.meta.type === 'close'))

        const closeFrame = frames.find((f) => f.meta.type === 'close') as { meta: { code?: number } } | undefined
        expect(closeFrame).toBeDefined()
        // 1000 is a valid close code; the runner passes it through (the hub normalizes via toClientCloseCode).
        expect(closeFrame?.meta.code).toBe(1000)
    })

    it('emits a token-unknown error and opens no upstream when the token is unregistered', async () => {
        const registry = new RunnerTunnelRegistry()
        const { socket, frames } = makeWsSocket()
        const proxy = new RunnerTunnelProxy(registry, FakeWebSocket as unknown as TunnelWebSocketCtor)
        proxy.attach(socket as never)
        const onFrame = (proxy as unknown as { onFrame: (...args: unknown[]) => void }).onFrame

        onFrame(wsOpenFrame('w3', '/api/agent-terminal/pty/abc'))
        await waitFor(() => frames.some((f) => f.meta.type === 'error'))

        const errorFrame = frames.find((f) => f.meta.type === 'error')
        expect(errorFrame?.meta.code).toBe('token-unknown')
        expect(created).toHaveLength(0)
    })
})
