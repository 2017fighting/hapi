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

describe('HubTunnelStreamManager — WebSocket streams (mode: "ws")', () => {
    // Fake browser-side ServerWebSocket: captures sent text + the close code/reason the
    // hub applies. Stands in for the browser PTY client upgraded by server.ts.
    class FakeBrowserWs {
        readyState = 1 // OPEN
        readonly sent: string[] = []
        closeCode: number | undefined
        closeReason: string | undefined
        constructor(public data: { token: string; streamId: string; wsPath: string; wsQuery: string }) {}
        send(data: string | ArrayBuffer | Uint8Array): void {
            this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
        }
        close(code?: number, reason?: string): void {
            this.closeCode = code
            this.closeReason = reason
        }
    }

    function openWs(manager: HubTunnelStreamManager, sock: FakeSocket, streamId: string, wsPath = '/api/agent-terminal/pty/abc'): FakeBrowserWs {
        const ws = new FakeBrowserWs({ token: TOKEN, streamId, wsPath, wsQuery: '' })
        manager.onBrowserWsOpen(ws as never)
        return ws
    }

    it('emits open{mode:"ws"} over the runner socket on browser WS open', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')

        const open = sock.emitted.find((e) => e.event === 'tunnel:frame' && (e.args[0] as { type?: string }).type === 'open')
        expect(open).toBeDefined()
        expect((open!.args[0] as { mode?: string }).mode).toBe('ws')
        expect((open!.args[0] as { path?: string }).path).toBe('/api/agent-terminal/pty/abc')
        expect(ws.closeCode).toBeUndefined()
    })

    it('closes the browser WS 1011 when no runner owns the token', () => {
        const manager = new HubTunnelStreamManager(fakeIo(new Map()), new TokenRegistry())
        const ws = new FakeBrowserWs({ token: 'unknown', streamId: 'ws-x', wsPath: '/', wsQuery: '' })
        manager.onBrowserWsOpen(ws as never)
        expect(ws.closeCode).toBe(1011)
    })

    it('bridges a runner data frame to the browser WS', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')
        manager.handleFrame(sock as never, { type: 'data', streamId: 'ws-1' }, new TextEncoder().encode('hello-pty'))

        expect(ws.sent).toEqual(['hello-pty'])
    })

    it('bridges a browser WS message to a runner data frame', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')
        manager.onBrowserWsMessage(ws as never, 'keystroke')

        const data = sock.emitted.find((e) => e.event === 'tunnel:frame' && (e.args[0] as { type?: string }).type === 'data')
        expect(data).toBeDefined()
        expect(new TextDecoder().decode(data!.args[1] as Uint8Array)).toBe('keystroke')
    })

    it('maps a reserved runner close code to 1011 via toClientCloseCode', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')
        // 1006 is reserved (abnormal drop) and cannot be sent; hub must normalize to 1011.
        manager.handleFrame(sock as never, { type: 'close', streamId: 'ws-1', code: 1006, reason: 'abnormal' }, undefined)

        expect(ws.closeCode).toBe(1011)
    })

    it('emits a tunnel close frame when the browser WS closes', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')
        manager.onBrowserWsClose(ws as never, 1000, 'normal')

        const close = sock.emitted.find((e) => e.event === 'tunnel:frame' && (e.args[0] as { type?: string }).type === 'close')
        expect(close).toBeDefined()
        expect((close!.args[0] as { code?: number }).code).toBe(1000)
    })

    it('tears down a WS stream (closes the browser WS 1011) on runner-socket disconnect', () => {
        const sock = fakeSocket('sock-1')
        const sockets = new Map([['sock-1', sock]])
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, TOKEN)
        const manager = new HubTunnelStreamManager(fakeIo(sockets), registry)

        const ws = openWs(manager, sock, 'ws-1')
        manager.teardownSocket('sock-1')

        expect(ws.closeCode).toBe(1011)
    })
})
