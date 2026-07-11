import type { Sql } from '../pgIndex'
import type { StoredMachine, VersionedUpdateResult } from '../types'
import { safeJsonParse } from '../json'

type DbMachineRow = {
    id: string
    namespace: string
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    runner_state: string | null
    runner_state_version: number
    active: number
    active_at: number | null
    seq: number
}

function toStoredMachine(row: DbMachineRow): StoredMachine {
    return {
        id: row.id,
        namespace: row.namespace,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        runnerState: safeJsonParse(row.runner_state),
        runnerStateVersion: row.runner_state_version,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

export async function getOrCreateMachine(
    sql: Sql,
    id: string,
    metadata: unknown,
    runnerState: unknown,
    namespace: string
): Promise<StoredMachine> {
    const rows = await sql`SELECT * FROM machines WHERE id = ${id}`
    const existing = rows[0] as DbMachineRow | undefined

    if (existing) {
        const stored = toStoredMachine(existing)
        if (stored.namespace !== namespace) {
            throw new Error('Machine namespace mismatch')
        }
        return stored
    }

    const now = Date.now()
    const metadataJson = JSON.stringify(metadata)
    const runnerStateJson = runnerState === null || runnerState === undefined ? null : JSON.stringify(runnerState)

    await sql`
        INSERT INTO machines (
            id, namespace, created_at, updated_at,
            metadata, metadata_version,
            runner_state, runner_state_version,
            active, active_at, seq
        ) VALUES (
            ${id}, ${namespace}, ${now}, ${now},
            ${metadataJson}, 1,
            ${runnerStateJson}, 1,
            0, NULL, 0
        )
    `

    const row = await getMachine(sql, id)
    if (!row) {
        throw new Error('Failed to create machine')
    }
    return row
}

export async function updateMachineMetadata(
    sql: Sql,
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string
): Promise<VersionedUpdateResult<unknown | null>> {
    const now = Date.now()
    const metadataJson = JSON.stringify(metadata)

    try {
        const result = await sql`
            UPDATE machines
            SET metadata = ${metadataJson},
                metadata_version = metadata_version + 1,
                updated_at = ${now},
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND metadata_version = ${expectedVersion}
        `
        if (result.count === 1) {
            return { result: 'success', version: expectedVersion + 1, value: metadata }
        }

        const currentRows = await sql`
            SELECT metadata, metadata_version
            FROM machines
            WHERE id = ${id} AND namespace = ${namespace}
        `
        const current = currentRows[0] as { metadata: string | null; metadata_version: number } | undefined
        if (!current) {
            return { result: 'error' }
        }
        return {
            result: 'version-mismatch',
            version: current.metadata_version,
            value: safeJsonParse(current.metadata)
        }
    } catch {
        return { result: 'error' }
    }
}

export async function updateMachineRunnerState(
    sql: Sql,
    id: string,
    runnerState: unknown,
    expectedVersion: number,
    namespace: string
): Promise<VersionedUpdateResult<unknown | null>> {
    const now = Date.now()
    const normalized = runnerState ?? null
    const encoded = normalized === null ? null : JSON.stringify(normalized)

    try {
        const result = await sql`
            UPDATE machines
            SET runner_state = ${encoded},
                runner_state_version = runner_state_version + 1,
                updated_at = ${now},
                active = 1,
                active_at = ${now},
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND runner_state_version = ${expectedVersion}
        `
        if (result.count === 1) {
            return { result: 'success', version: expectedVersion + 1, value: normalized }
        }

        const currentRows = await sql`
            SELECT runner_state, runner_state_version
            FROM machines
            WHERE id = ${id} AND namespace = ${namespace}
        `
        const current = currentRows[0] as { runner_state: string | null; runner_state_version: number } | undefined
        if (!current) {
            return { result: 'error' }
        }
        return {
            result: 'version-mismatch',
            version: current.runner_state_version,
            value: safeJsonParse(current.runner_state)
        }
    } catch {
        return { result: 'error' }
    }
}

export async function getMachine(sql: Sql, id: string): Promise<StoredMachine | null> {
    const rows = await sql`SELECT * FROM machines WHERE id = ${id}`
    const row = rows[0] as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export async function getMachineByNamespace(sql: Sql, id: string, namespace: string): Promise<StoredMachine | null> {
    const rows = await sql`SELECT * FROM machines WHERE id = ${id} AND namespace = ${namespace}`
    const row = rows[0] as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export async function getMachines(sql: Sql): Promise<StoredMachine[]> {
    const rows = await sql`SELECT * FROM machines ORDER BY updated_at DESC`
    return (rows as unknown as DbMachineRow[]).map(toStoredMachine)
}

export async function getMachinesByNamespace(sql: Sql, namespace: string): Promise<StoredMachine[]> {
    const rows = await sql`SELECT * FROM machines WHERE namespace = ${namespace} ORDER BY updated_at DESC`
    return (rows as unknown as DbMachineRow[]).map(toStoredMachine)
}
