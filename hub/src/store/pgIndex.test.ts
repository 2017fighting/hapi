import { describe, expect, it } from 'bun:test'
import postgres from 'postgres'
import { Store, bigintToNumber } from './pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

// This test verifies Store.create applies the schema from a clean slate and
// returns BIGINT as a JS number. It DROPs tables, so it runs against a
// dedicated database — NOT the shared `hapitest` DB that createTestStore()'s
// pool uses. Otherwise the table drops clobber every parallel test that relies
// on createTestStore() ("relation does not exist").
const ISOLATED_DB = 'hapitest_pgindex'

function adminUrl(): string {
    const u = new URL(TEST_URL!)
    u.pathname = '/postgres'
    return u.toString()
}

function isolatedUrl(): string {
    const u = new URL(TEST_URL!)
    u.pathname = '/' + ISOLATED_DB
    return u.toString()
}

describe('Store.create (Postgres)', () => {
    itPg('applies schema and returns BIGINT as JS number', async () => {
        // Provision a fresh dedicated DB so destructive drops stay isolated.
        const admin = postgres(adminUrl(), { types: { bigint: bigintToNumber } })
        await admin.unsafe(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`)
        await admin.unsafe(`CREATE DATABASE ${ISOLATED_DB}`)
        await admin.end()

        try {
            const store = await Store.create(isolatedUrl())
            const inner = (store as unknown as { sql: postgres.Sql }).sql
            await inner`INSERT INTO machines (id, namespace, created_at, updated_at) VALUES ('m1', 'default', 1700000000000, 1700000000000)`
            const [m1] = await inner`SELECT created_at FROM machines WHERE id = 'm1'`
            expect(typeof m1.created_at).toBe('number')   // ← the BIGINT guard
            expect(m1.created_at).toBe(1700000000000)

            const [v] = await inner`SELECT version FROM schema_migrations`
            expect(v.version).toBe(1)

            await store.close()
        } finally {
            const cleanup = postgres(adminUrl(), { types: { bigint: bigintToNumber } })
            await cleanup.unsafe(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`)
            await cleanup.end()
        }
    })
})
