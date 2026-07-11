import { describe, expect, it } from 'bun:test'
import postgres from 'postgres'
import { Store, bigintToNumber } from './pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

describe('Store.create (Postgres)', () => {
    itPg('applies schema and returns BIGINT as JS number', async () => {
        const sql = postgres(TEST_URL!, { types: { bigint: bigintToNumber } })
        await sql`DROP TABLE IF EXISTS messages, sessions, machines, users, push_subscriptions, schema_migrations CASCADE`
        await sql.end()

        const store = await Store.create(TEST_URL!)
        const inner = (store as unknown as { sql: postgres.Sql }).sql
        await inner`INSERT INTO machines (id, namespace, created_at, updated_at) VALUES ('m1', 'default', 1700000000000, 1700000000000)`
        const [m1] = await inner`SELECT created_at FROM machines WHERE id = 'm1'`
        expect(typeof m1.created_at).toBe('number')   // ← the BIGINT guard
        expect(m1.created_at).toBe(1700000000000)

        const [v] = await inner`SELECT version FROM schema_migrations`
        expect(v.version).toBe(1)

        await inner`DROP TABLE IF EXISTS messages, sessions, machines, users, push_subscriptions, schema_migrations CASCADE`
        await store.close()
    })
})
