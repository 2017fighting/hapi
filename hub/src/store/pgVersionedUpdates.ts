import type { Sql } from './pgIndex'
import type { VersionedUpdateResult } from './types'

const TABLES = new Set(['sessions', 'machines'])
function assertIdentifier(name: string, kind: string): void {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
        throw new Error(`updateVersionedField: invalid ${kind} identifier: ${name}`)
    }
}

type VersionedUpdateArgs<T> = {
    sql: Sql
    table: 'sessions' | 'machines'
    id: string
    namespace: string
    field: string
    versionField: string
    expectedVersion: number
    value: T
    encode: (value: T) => string | null
    decode: (value: string | null) => T
}

export async function updateVersionedField<T>(args: VersionedUpdateArgs<T>): Promise<VersionedUpdateResult<T>> {
    assertIdentifier(args.table, 'table')
    assertIdentifier(args.field, 'field')
    assertIdentifier(args.versionField, 'versionField')
    if (!TABLES.has(args.table)) throw new Error(`unsupported table: ${args.table}`)

    try {
        const table = args.sql.unsafe(args.table)
        const field = args.sql.unsafe(args.field)
        const versionField = args.sql.unsafe(args.versionField)

        const result = await args.sql`
            UPDATE ${table}
            SET ${field} = ${args.encode(args.value)},
                ${versionField} = ${versionField} + 1
            WHERE id = ${args.id}
              AND namespace = ${args.namespace}
              AND ${versionField} = ${args.expectedVersion}
        `
        if (result.count === 1) {
            return { result: 'success', version: args.expectedVersion + 1, value: args.value }
        }

        const rows = await args.sql`
            SELECT ${field} AS field_value, ${versionField} AS version
            FROM ${table}
            WHERE id = ${args.id} AND namespace = ${args.namespace}
        `
        const current = rows[0] as { field_value: string | null; version: number } | undefined
        if (!current) return { result: 'error' }
        return { result: 'version-mismatch', version: current.version, value: args.decode(current.field_value) }
    } catch {
        return { result: 'error' }
    }
}
