import { describe, expect, it } from 'bun:test'
import postgres from 'postgres'
import { createTestStore } from './testStore'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

describe('createTestStore', () => {
    itPg('returns an empty store (TRUNCATE between calls)', async () => {
        const s1 = await createTestStore()
        const sql = (s1 as unknown as { sql: postgres.Sql }).sql
        await sql`INSERT INTO machines (id, namespace, created_at, updated_at) VALUES ('x', 'default', 1, 1)`
        const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM machines`
        expect(n).toBe(1)

        const s2 = await createTestStore()
        const sql2 = (s2 as unknown as { sql: postgres.Sql }).sql
        const [{ n: n2 }] = await sql2`SELECT COUNT(*)::int AS n FROM machines`
        expect(n2).toBe(0) // truncated between calls
    })
})
