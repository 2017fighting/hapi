import type { Sql } from '../pgIndex'
import type { StoredMachine, VersionedUpdateResult } from '../types'
import {
    getMachine,
    getMachineByNamespace,
    getMachines,
    getMachinesByNamespace,
    getOrCreateMachine,
    updateMachineMetadata,
    updateMachineRunnerState
} from './machines'

export class MachineStore {
    private readonly sql: Sql

    constructor(sql: Sql) {
        this.sql = sql
    }

    async getOrCreateMachine(
        id: string,
        metadata: unknown,
        runnerState: unknown,
        namespace: string
    ): Promise<StoredMachine> {
        return await getOrCreateMachine(this.sql, id, metadata, runnerState, namespace)
    }

    async updateMachineMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return await updateMachineMetadata(this.sql, id, metadata, expectedVersion, namespace)
    }

    async updateMachineRunnerState(
        id: string,
        runnerState: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return await updateMachineRunnerState(this.sql, id, runnerState, expectedVersion, namespace)
    }

    async getMachine(id: string): Promise<StoredMachine | null> {
        return await getMachine(this.sql, id)
    }

    async getMachineByNamespace(id: string, namespace: string): Promise<StoredMachine | null> {
        return await getMachineByNamespace(this.sql, id, namespace)
    }

    async getMachines(): Promise<StoredMachine[]> {
        return await getMachines(this.sql)
    }

    async getMachinesByNamespace(namespace: string): Promise<StoredMachine[]> {
        return await getMachinesByNamespace(this.sql, namespace)
    }
}
