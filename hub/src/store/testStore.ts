import postgres from 'postgres'
import { Store, bigintToNumber, type Sql } from './pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL

let _sharedSql: Sql | null = null

const TABLES = ['messages', 'sessions', 'machines', 'users', 'push_subscriptions'] as const

async function getSharedSql(): Promise<Sql> {
    if (!_sharedSql) {
        if (!TEST_URL) {
            throw new Error(
                'TEST_DATABASE_URL not set. Run `docker compose -f hub/docker-compose.test.yml up -d --wait` ' +
                'and set TEST_DATABASE_URL, or skip PG tests.'
            )
        }
        const sql = postgres(TEST_URL, { types: { bigint: bigintToNumber } })
        await Store.create(TEST_URL, { sql }) // ensures schema exists once
        _sharedSql = sql
    }
    return _sharedSql
}

export async function createTestStore(): Promise<Store> {
    const sql = await getSharedSql()
    await sql.begin(async (tx) => {
        await tx`TRUNCATE TABLE ${sql.unsafe(TABLES.join(', '))} RESTART IDENTITY CASCADE`
    })
    return await Store.create('', { sql })
}
