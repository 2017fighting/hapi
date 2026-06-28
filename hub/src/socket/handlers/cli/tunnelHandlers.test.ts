import { describe, expect, it } from 'bun:test'
import type { TunnelRegisterAck } from '@hapi/protocol'
import type { HubTunnelStreamManager } from '../../tunnelStreamManager'
import { TokenRegistry } from '../../tokenRegistry'
import { registerTunnelHandlers } from './tunnelHandlers'

interface FakeSocket {
    id: string
    on: (event: string, handler: (...args: unknown[]) => void) => void
    handlers: Map<string, (...args: unknown[]) => void>
}

function fakeSocket(id: string): FakeSocket {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    return {
        id,
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
})
