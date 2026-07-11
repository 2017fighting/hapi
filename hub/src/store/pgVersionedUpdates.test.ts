import { describe, expect, it } from 'bun:test'
import { createTestStore } from './testStore'
import { updateVersionedField } from './pgVersionedUpdates'
import type { Sql } from './pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

describe('updateVersionedField (PG)', () => {
    itPg('updates on matching version, returns new version', async () => {
        const store = await createTestStore()
        const sql = (store as unknown as { sql: Sql }).sql
        await sql`INSERT INTO machines (id, namespace, created_at, updated_at, metadata, metadata_version) VALUES ('m', 'default', 1, 1, '{"a":1}', 1)`
        const r = await updateVersionedField({
            sql, table: 'machines', id: 'm', namespace: 'default',
            field: 'metadata', versionField: 'metadata_version',
            expectedVersion: 1, value: '{"a":2}',
            encode: (v: string): string | null => v, decode: (v: string | null): string => v ?? '',
        })
        expect(r.result).toBe('success')
        if (r.result === 'success') expect(r.version).toBe(2)
        const [row] = await sql`SELECT metadata, metadata_version FROM machines WHERE id = 'm'`
        expect(row.metadata).toBe('{"a":2}')
        expect(Number(row.metadata_version)).toBe(2)
    })

    itPg('returns version-mismatch when expectedVersion is stale', async () => {
        const store = await createTestStore()
        const sql = (store as unknown as { sql: Sql }).sql
        await sql`INSERT INTO machines (id, namespace, created_at, updated_at, metadata, metadata_version) VALUES ('m', 'default', 1, 1, '{"a":1}', 5)`
        const r = await updateVersionedField({
            sql, table: 'machines', id: 'm', namespace: 'default',
            field: 'metadata', versionField: 'metadata_version',
            expectedVersion: 1, value: '{"a":2}',
            encode: (v: string): string | null => v, decode: (v: string | null): string => v ?? '',
        })
        expect(r.result).toBe('version-mismatch')
        if (r.result === 'version-mismatch') expect(r.version).toBe(5)
    })
})
