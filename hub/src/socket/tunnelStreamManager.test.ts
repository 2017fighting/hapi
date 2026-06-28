import { describe, expect, it } from 'bun:test'
import type { SocketServer } from './socketTypes'
import { TokenRegistry } from './tokenRegistry'
import { HubTunnelStreamManager } from './tunnelStreamManager'

interface FakeSocket {
    id: string
    emitted: Array<{ event: string; args: unknown[] }>
    emit: (...args: unknown[]) => void
}

function fakeSocket(id: string): FakeSocket {
    const emitted: FakeSocket['emitted'] = []
    return {
        id,
        emitted,
        emit: (...args: unknown[]) => {
            emitted.push({ event: args[0] as string, args: args.slice(1) })
        }
    }
}

function fakeIo(sockets: Map<string, FakeSocket>): SocketServer {
    return {
        of: () => ({
            sockets: {
                get: (id: string) => sockets.get(id)
            }
        })
    } as unknown as SocketServer
}

const TOKEN = '0123456789abcdef0123456789abcdef'

function captureStreamId(socket: FakeSocket): string {
    const open = socket.emitted.find((e) => e.event === 'tunnel:frame' && (e.args[0] as { type?: string })?.type === 'open')
    if (!open) {
        throw new Error('no open frame emitted')
    }
    return (open.args[0] as { streamId: string }).streamId
}

describe('HubTunnelStreamManager', () => {
    it('returns 503 when no runner owns the token', async () => {
        const registry = new TokenRegistry()
        const manager = new HubTunnelStreamManager(fakeIo(new Map()), registry)

        const res = await manager.openStream({
            token: 'unknown',
            method: 'GET',
            path: '/api/plan',
            query: '',
            headers: {},
            body: null
        })

        expect(res.status).toBe(503)
    })

    it('round-trips an opportunistic inline response (headers{fin,buffer})', async () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const promise = manager.openStream({
            token: TOKEN,
            method: 'GET',
            path: '/api/plan',
            query: '',
            headers: {},
            body: null
        })

        const streamId = captureStreamId(sock)
        manager.handleFrame(sock as never, { type: 'headers', streamId, status: 200, headers: { 'content-type': 'text/plain' }, fin: true }, new TextEncoder().encode('hello world'))

        const res = await promise
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('hello world')
    })

    it('round-trips a streamed response (headers → data → end)', async () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const promise = manager.openStream({
            token: TOKEN,
            method: 'GET',
            path: '/api/plan',
            query: '',
            headers: {},
            body: null
        })

        const streamId = captureStreamId(sock)
        manager.handleFrame(sock as never, { type: 'headers', streamId, status: 200, headers: {} })
        manager.handleFrame(sock as never, { type: 'data', streamId }, new TextEncoder().encode('foo'))
        manager.handleFrame(sock as never, { type: 'data', streamId }, new TextEncoder().encode('bar'))
        manager.handleFrame(sock as never, { type: 'end', streamId })

        const res = await promise
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('foobar')
    })

    it('maps a runner error before headers to HTTP 502', async () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const promise = manager.openStream({
            token: TOKEN,
            method: 'GET',
            path: '/api/plan',
            query: '',
            headers: {},
            body: null
        })

        const streamId = captureStreamId(sock)
        manager.handleFrame(sock as never, { type: 'error', streamId, code: 'upstream-unreachable', msg: 'no plannotator there' })

        const res = await promise
        expect(res.status).toBe(502)
    })

    it('tears down every stream owned by a disconnecting runner socket', async () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const promise = manager.openStream({
            token: TOKEN,
            method: 'GET',
            path: '/api/plan',
            query: '',
            headers: {},
            body: null
        })

        // Runner vanishes before responding -> teardown must reject the open stream.
        manager.teardownSocket('sock-1')

        const res = await promise
        expect(res.status).toBe(502)
    })
})
