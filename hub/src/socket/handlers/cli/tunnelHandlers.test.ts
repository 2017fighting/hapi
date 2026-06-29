import { describe, expect, it } from 'bun:test'
import type { TunnelRegisterAck } from '@hapi/protocol'
import type { HubTunnelStreamManager } from '../../tunnelStreamManager'
import { TokenRegistry } from '../../tokenRegistry'
import { registerTunnelHandlers } from './tunnelHandlers'

interface FakeSocket {
    id: string
    data?: { namespace?: string }
    on: (event: string, handler: (...args: unknown[]) => void) => void
    handlers: Map<string, (...args: unknown[]) => void>
}

function fakeSocket(id: string, data?: { namespace?: string }): FakeSocket {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    return {
        id,
        data,
        on: (event, handler) => {
            handlers.set(event, handler)
        },
        handlers
    }
}

// 128-bit hex token, as minted by the runner (crypto.randomBytes(16).toString('hex')).
const VALID_TOKEN = '0123456789abcdef0123456789abcdef'

// register/unregister don't exercise the stream manager (covered by tunnelStreamManager.test.ts).
const stubStreamManager = { handleFrame: () => {} } as unknown as HubTunnelStreamManager

describe('registerTunnelHandlers', () => {
    it('registers a valid token to the owning socket and acks ok', () => {
        const socket = fakeSocket('sock-1')
        const registry = new TokenRegistry()
        registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager)

        let ack: TunnelRegisterAck | undefined
        socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN }, (a: TunnelRegisterAck) => {
            ack = a
        })

        expect(registry.getSocketIdForToken(VALID_TOKEN)).toBe('sock-1')
        expect(ack).toEqual({ ok: true })
    })

    it('rejects a malformed token and does not register it', () => {
        const socket = fakeSocket('sock-1')
        const registry = new TokenRegistry()
        registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager)

        let ack: TunnelRegisterAck | undefined
        socket.handlers.get('tunnel:register')!({ token: 'not-a-hex-token' }, (a: TunnelRegisterAck) => {
            ack = a
        })

        expect(ack).toEqual({ ok: false, error: 'invalid-token' })
        expect(registry.getSocketIdForToken('not-a-hex-token')).toBeNull()
    })

    it('unregisters a previously-registered token', () => {
        const socket = fakeSocket('sock-1')
        const registry = new TokenRegistry()
        registry.register({ id: 'sock-1' } as never, VALID_TOKEN)
        registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager)

        socket.handlers.get('tunnel:unregister')!({ token: VALID_TOKEN })

        expect(registry.getSocketIdForToken(VALID_TOKEN)).toBeNull()
    })

    it('ignores an unregister for an unknown token', () => {
        const socket = fakeSocket('sock-1')
        const registry = new TokenRegistry()
        registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager)

        // Must not throw
        socket.handlers.get('tunnel:unregister')!({ token: '0123456789abcdef0123456789abcdef' })

        expect(registry.getSocketIdForToken(VALID_TOKEN)).toBeNull()
    })

    describe('plannotator:opened notification (Phase 5 #6)', () => {
        it('fires onPlannotatorOpened for a review-mode registration with the owning namespace', () => {
            const socket = fakeSocket('sock-1', { namespace: 'ns-1' })
            const registry = new TokenRegistry()
            const opened: Array<{ namespace: string; mode?: string; label?: string; token: string }> = []
            registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager, {
                onPlannotatorOpened: (info) => opened.push(info)
            })

            socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN, mode: 'review', label: 'code review' }, () => {})

            // Still registered + acked (transport unaffected by the notification).
            expect(registry.getSocketIdForToken(VALID_TOKEN)).toBe('sock-1')
            expect(opened).toEqual([{ namespace: 'ns-1', mode: 'review', label: 'code review', token: VALID_TOKEN }])
        })

        it('fires for annotate mode too', () => {
            const socket = fakeSocket('sock-1', { namespace: 'ns-1' })
            const registry = new TokenRegistry()
            const opened: unknown[] = []
            registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager, {
                onPlannotatorOpened: (info) => opened.push(info)
            })

            socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN, mode: 'annotate' }, () => {})

            expect(opened).toHaveLength(1)
        })

        it('does not fire for plan-review mode (driven by the permission UI) but still registers', () => {
            const socket = fakeSocket('sock-1', { namespace: 'ns-1' })
            const registry = new TokenRegistry()
            const opened: unknown[] = []
            registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager, {
                onPlannotatorOpened: (info) => opened.push(info)
            })

            socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN, mode: 'plan' }, () => {})

            expect(opened).toHaveLength(0)
            expect(registry.getSocketIdForToken(VALID_TOKEN)).toBe('sock-1')
        })

        it('does not fire when mode is absent (generic / non-plannotator tunnel)', () => {
            const socket = fakeSocket('sock-1', { namespace: 'ns-1' })
            const registry = new TokenRegistry()
            const opened: unknown[] = []
            registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager, {
                onPlannotatorOpened: (info) => opened.push(info)
            })

            socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN }, () => {})

            expect(opened).toHaveLength(0)
            expect(registry.getSocketIdForToken(VALID_TOKEN)).toBe('sock-1')
        })

        it('does not fire when the socket has no namespace, but still registers', () => {
            const socket = fakeSocket('sock-1') // no data.namespace
            const registry = new TokenRegistry()
            const opened: unknown[] = []
            registerTunnelHandlers(socket as unknown as never, registry, stubStreamManager, {
                onPlannotatorOpened: (info) => opened.push(info)
            })

            socket.handlers.get('tunnel:register')!({ token: VALID_TOKEN, mode: 'review' }, () => {})

            expect(opened).toHaveLength(0)
            expect(registry.getSocketIdForToken(VALID_TOKEN)).toBe('sock-1')
        })
    })
})
