import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { RunnerTunnelRegistry } from './runnerTunnelRegistry'
import { RunnerTunnelProxy } from './tunnelProxy'

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
