import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Sql } from '../pgIndex'
import { MachineStore } from './machineStore'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function makeStore(): Promise<MachineStore> {
    const store = await createTestStore()
    const sql = (store as unknown as StoreLike).sql
    return new MachineStore(sql)
}

describe('getOrCreateMachine', () => {
    itPg('creates a new machine when id is absent', async () => {
        const store = await makeStore()
        const machine = await store.getOrCreateMachine(
            'mach-create-1',
            { hostname: 'host-1' },
            { pid: 123 },
            'default'
        )
        expect(machine.id).toBe('mach-create-1')
        expect(machine.namespace).toBe('default')
        expect(machine.metadataVersion).toBe(1)
        expect(machine.runnerStateVersion).toBe(1)
        expect(machine.active).toBe(false)
        expect(machine.activeAt).toBeNull()
        expect(machine.seq).toBe(0)
        expect(machine.metadata).toEqual({ hostname: 'host-1' })
        expect(machine.runnerState).toEqual({ pid: 123 })
    })

    itPg('returns the existing machine when id is present', async () => {
        const store = await makeStore()
        const first = await store.getOrCreateMachine(
            'mach-existing',
            { hostname: 'host-1' },
            null,
            'default'
        )
        const second = await store.getOrCreateMachine(
            'mach-existing',
            { hostname: 'host-1' },
            null,
            'default'
        )
        expect(second.id).toBe(first.id)
        expect(second.metadataVersion).toBe(first.metadataVersion)
    })

    itPg('throws on namespace mismatch when the same id exists in a different namespace', async () => {
        const store = await makeStore()
        await store.getOrCreateMachine(
            'mach-mismatch',
            null,
            null,
            'default'
        )
        await expect(
            store.getOrCreateMachine('mach-mismatch', null, null, 'other')
        ).rejects.toThrow('Machine namespace mismatch')
    })
})

describe('updateMachineMetadata', () => {
    itPg('succeeds when the expected version matches and bumps the version', async () => {
        const store = await makeStore()
        const machine = await store.getOrCreateMachine(
            'mach-meta-success',
            { hostname: 'host-1' },
            null,
            'default'
        )
        const result = await store.updateMachineMetadata(
            machine.id,
            { hostname: 'host-2' },
            machine.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')
        if (result.result === 'success') {
            expect(result.version).toBe(machine.metadataVersion + 1)
            expect(result.value).toEqual({ hostname: 'host-2' })
        }
        const row = await store.getMachine(machine.id)
        expect(row?.metadata).toEqual({ hostname: 'host-2' })
        expect(row?.metadataVersion).toBe(machine.metadataVersion + 1)
    })

    itPg('returns version-mismatch when the expected version is stale', async () => {
        const store = await makeStore()
        const machine = await store.getOrCreateMachine(
            'mach-meta-mismatch',
            { hostname: 'host-1' },
            null,
            'default'
        )
        const result = await store.updateMachineMetadata(
            machine.id,
            { hostname: 'host-2' },
            machine.metadataVersion + 99,
            'default'
        )
        expect(result.result).toBe('version-mismatch')
        if (result.result === 'version-mismatch') {
            expect(result.version).toBe(machine.metadataVersion)
        }
    })

    itPg('returns error when the machine row does not exist', async () => {
        const store = await makeStore()
        const result = await store.updateMachineMetadata(
            'no-such-machine',
            { hostname: 'host-1' },
            0,
            'default'
        )
        expect(result.result).toBe('error')
    })
})

describe('updateMachineRunnerState', () => {
    itPg('succeeds when the expected version matches, sets active=true and activeAt', async () => {
        const store = await makeStore()
        const machine = await store.getOrCreateMachine(
            'mach-runner-success',
            null,
            { status: 'idle' },
            'default'
        )
        expect(machine.active).toBe(false)
        const before = Date.now()
        const result = await store.updateMachineRunnerState(
            machine.id,
            { status: 'running' },
            machine.runnerStateVersion,
            'default'
        )
        const after = Date.now()
        expect(result.result).toBe('success')
        if (result.result === 'success') {
            expect(result.version).toBe(machine.runnerStateVersion + 1)
            expect(result.value).toEqual({ status: 'running' })
        }
        const row = await store.getMachine(machine.id)
        expect(row?.runnerState).toEqual({ status: 'running' })
        expect(row?.runnerStateVersion).toBe(machine.runnerStateVersion + 1)
        expect(row?.active).toBe(true)
        expect(row?.activeAt).not.toBeNull()
        if (row && row.activeAt !== null) {
            expect(row.activeAt).toBeGreaterThanOrEqual(before)
            expect(row.activeAt).toBeLessThanOrEqual(after)
        }
    })

    itPg('returns version-mismatch when the expected version is stale', async () => {
        const store = await makeStore()
        const machine = await store.getOrCreateMachine(
            'mach-runner-mismatch',
            null,
            { status: 'idle' },
            'default'
        )
        const result = await store.updateMachineRunnerState(
            machine.id,
            { status: 'running' },
            machine.runnerStateVersion + 99,
            'default'
        )
        expect(result.result).toBe('version-mismatch')
        if (result.result === 'version-mismatch') {
            expect(result.version).toBe(machine.runnerStateVersion)
        }
    })

    itPg('returns error when the machine row does not exist', async () => {
        const store = await makeStore()
        const result = await store.updateMachineRunnerState(
            'no-such-machine',
            { status: 'running' },
            0,
            'default'
        )
        expect(result.result).toBe('error')
    })
})

describe('getMachine / getMachineByNamespace', () => {
    itPg('getMachine returns null when absent', async () => {
        const store = await makeStore()
        expect(await store.getMachine('absent')).toBeNull()
    })

    itPg('getMachine returns the row regardless of namespace', async () => {
        const store = await makeStore()
        await store.getOrCreateMachine('mach-get-1', null, null, 'ns-a')
        const row = await store.getMachine('mach-get-1')
        expect(row?.id).toBe('mach-get-1')
        expect(row?.namespace).toBe('ns-a')
    })

    itPg('getMachineByNamespace scopes by namespace', async () => {
        const store = await makeStore()
        await store.getOrCreateMachine('mach-ns-1', null, null, 'ns-a')
        await store.getOrCreateMachine('mach-ns-2', null, null, 'ns-b')
        expect((await store.getMachineByNamespace('mach-ns-1', 'ns-a'))?.id).toBe('mach-ns-1')
        expect(await store.getMachineByNamespace('mach-ns-1', 'ns-b')).toBeNull()
        expect(await store.getMachineByNamespace('mach-ns-2', 'ns-a')).toBeNull()
        expect((await store.getMachineByNamespace('mach-ns-2', 'ns-b'))?.id).toBe('mach-ns-2')
    })
})

describe('getMachines / getMachinesByNamespace', () => {
    itPg('getMachines returns all rows ordered by updated_at DESC', async () => {
        const store = await makeStore()
        const a = await store.getOrCreateMachine('mach-list-a', null, null, 'ns-a')
        // bump updated_at on a second machine so it sorts first
        const b = await store.getOrCreateMachine('mach-list-b', null, null, 'ns-b')
        await store.updateMachineMetadata(b.id, { tick: 1 }, b.metadataVersion, 'ns-b')

        const all = await store.getMachines()
        expect(all.length).toBe(2)
        expect(all[0].id).toBe('mach-list-b')
        expect(all[1].id).toBe('mach-list-a')
        // sanity: returned objects have full StoredMachine shape
        expect(all[0].namespace).toBe('ns-b')
        expect(all[0].metadataVersion).toBe(a.metadataVersion + 1)
    })

    itPg('getMachinesByNamespace scopes by namespace', async () => {
        const store = await makeStore()
        await store.getOrCreateMachine('mach-scope-a', null, null, 'ns-a')
        await store.getOrCreateMachine('mach-scope-b', null, null, 'ns-b')

        const nsA = await store.getMachinesByNamespace('ns-a')
        expect(nsA.length).toBe(1)
        expect(nsA[0].id).toBe('mach-scope-a')

        const nsB = await store.getMachinesByNamespace('ns-b')
        expect(nsB.length).toBe(1)
        expect(nsB[0].id).toBe('mach-scope-b')

        expect((await store.getMachinesByNamespace('ns-empty')).length).toBe(0)
    })
})
