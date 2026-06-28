import { describe, expect, it } from 'bun:test'
import { RunnerTunnelRegistry } from './runnerTunnelRegistry'

describe('RunnerTunnelRegistry', () => {
    it('registers and resolves a token to its entry', () => {
        const registry = new RunnerTunnelRegistry()
        registry.register('tok', { port: 1234, createdAt: 1 })
        expect(registry.get('tok')?.port).toBe(1234)
    })

    it('returns undefined for an unknown token', () => {
        const registry = new RunnerTunnelRegistry()
        expect(registry.get('nope')).toBeUndefined()
    })

    it('deletes a registered token', () => {
        const registry = new RunnerTunnelRegistry()
        registry.register('tok', { port: 1, createdAt: 0 })
        expect(registry.delete('tok')).toBe(true)
        expect(registry.get('tok')).toBeUndefined()
    })

    it('lists every live entry', () => {
        const registry = new RunnerTunnelRegistry()
        registry.register('a', { port: 1, createdAt: 0 })
        registry.register('b', { port: 2, createdAt: 0 })
        expect(registry.list().map(([token]) => token).sort()).toEqual(['a', 'b'])
    })
})
