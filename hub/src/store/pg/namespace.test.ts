import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Store } from '../pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

describe('Store namespace filtering', () => {
    itPg('filters sessions by namespace', async () => {
        const store: Store = await createTestStore()
        const sessionAlpha = await store.sessions.getOrCreateSession('tag', { path: '/alpha' }, null, 'alpha')
        const sessionBeta = await store.sessions.getOrCreateSession('tag', { path: '/beta' }, null, 'beta')

        const sessionsAlpha = await store.sessions.getSessionsByNamespace('alpha')
        const ids = sessionsAlpha.map((session) => session.id)

        expect(ids).toContain(sessionAlpha.id)
        expect(ids).not.toContain(sessionBeta.id)
    })

    itPg('filters machines by namespace and blocks mismatches', async () => {
        const store: Store = await createTestStore()
        const machineAlpha = await store.machines.getOrCreateMachine('machine-1', { host: 'alpha' }, null, 'alpha')
        await store.machines.getOrCreateMachine('machine-2', { host: 'beta' }, null, 'beta')

        const machinesAlpha = await store.machines.getMachinesByNamespace('alpha')
        const ids = machinesAlpha.map((machine) => machine.id)

        expect(ids).toContain(machineAlpha.id)
        expect(ids).not.toContain('machine-2')
        await expect(store.machines.getOrCreateMachine('machine-1', { host: 'beta' }, null, 'beta')).rejects.toThrow()
    })
})
