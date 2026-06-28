import { describe, expect, it } from 'bun:test'
import type { Socket } from 'socket.io'
import { TokenRegistry } from './tokenRegistry'

function fakeSocket(id: string): Socket {
    return { id } as unknown as Socket
}

describe('TokenRegistry', () => {
    it('registers a token and resolves it to the owning socket', () => {
        const registry = new TokenRegistry()
        registry.register(fakeSocket('sock-1'), 'tok-a')

        expect(registry.getSocketIdForToken('tok-a')).toBe('sock-1')
    })

    it('returns null for an unknown token', () => {
        const registry = new TokenRegistry()
        expect(registry.getSocketIdForToken('nope')).toBeNull()
    })

    it('ignores empty tokens', () => {
        const registry = new TokenRegistry()
        registry.register(fakeSocket('sock-1'), '')

        expect(registry.getSocketIdForToken('')).toBeNull()
    })

    it('supports many tokens per socket', () => {
        const registry = new TokenRegistry()
        const socket = fakeSocket('sock-1')

        registry.register(socket, 'tok-a')
        registry.register(socket, 'tok-b')

        expect(registry.getSocketIdForToken('tok-a')).toBe('sock-1')
        expect(registry.getSocketIdForToken('tok-b')).toBe('sock-1')
    })

    it('unregister removes a single token but keeps the socket\'s other tokens', () => {
        const registry = new TokenRegistry()
        const socket = fakeSocket('sock-1')

        registry.register(socket, 'tok-a')
        registry.register(socket, 'tok-b')
        registry.unregister(socket, 'tok-a')

        expect(registry.getSocketIdForToken('tok-a')).toBeNull()
        expect(registry.getSocketIdForToken('tok-b')).toBe('sock-1')
    })

    it('unregister only drops a token that belongs to that socket', () => {
        const registry = new TokenRegistry()
        const owner = fakeSocket('sock-1')
        const other = fakeSocket('sock-2')

        registry.register(owner, 'tok-a')
        // A different socket cannot steal-unregister a token it doesn't own.
        registry.unregister(other, 'tok-a')

        expect(registry.getSocketIdForToken('tok-a')).toBe('sock-1')
    })

    it('unregisterAll drops every token the socket owned', () => {
        const registry = new TokenRegistry()
        const socket = fakeSocket('sock-1')

        registry.register(socket, 'tok-a')
        registry.register(socket, 'tok-b')
        registry.unregisterAll(socket)

        expect(registry.getSocketIdForToken('tok-a')).toBeNull()
        expect(registry.getSocketIdForToken('tok-b')).toBeNull()
    })

    it('unregisterAll only affects the given socket', () => {
        const registry = new TokenRegistry()
        const socket1 = fakeSocket('sock-1')
        const socket2 = fakeSocket('sock-2')

        registry.register(socket1, 'tok-a')
        registry.register(socket2, 'tok-b')
        registry.unregisterAll(socket1)

        expect(registry.getSocketIdForToken('tok-a')).toBeNull()
        expect(registry.getSocketIdForToken('tok-b')).toBe('sock-2')
    })

    it('re-registering a token rebinds it to the new socket', () => {
        const registry = new TokenRegistry()
        const socket1 = fakeSocket('sock-1')
        const socket2 = fakeSocket('sock-2')

        registry.register(socket1, 'tok-a')
        registry.register(socket2, 'tok-a')

        expect(registry.getSocketIdForToken('tok-a')).toBe('sock-2')
        // The previous owner must not be able to unregister it away from socket2.
        registry.unregister(socket1, 'tok-a')
        expect(registry.getSocketIdForToken('tok-a')).toBe('sock-2')
    })
})
