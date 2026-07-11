import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import postgres from 'postgres'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bigintToNumber } from '../src/store/pgIndex'
import { migrateSqliteToPostgres } from './migrate-sqlite-to-postgres'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

// Dedicated DB — the migrator truncates its target, so it must not share the
// `hapitest` DB that createTestStore()'s parallel pool uses.
const ISOLATED_DB = 'hapitest_migrate'

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

// Build a V10-shape SQLite file (column names match the migrator's COLUMNS map).
function buildSourceSqlite(path: string): void {
    const db = new Database(path)
    db.run(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, tag TEXT, namespace TEXT, machine_id TEXT, created_at INTEGER, updated_at INTEGER, metadata TEXT, metadata_version INTEGER, agent_state TEXT, agent_state_version INTEGER, model TEXT, model_reasoning_effort TEXT, effort TEXT, service_tier TEXT, todos TEXT, todos_updated_at INTEGER, team_state TEXT, team_state_updated_at INTEGER, active INTEGER, active_at INTEGER, seq INTEGER);
        CREATE TABLE machines (id TEXT PRIMARY KEY, namespace TEXT, created_at INTEGER, updated_at INTEGER, metadata TEXT, metadata_version INTEGER, runner_state TEXT, runner_state_version INTEGER, active INTEGER, active_at INTEGER, seq INTEGER);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, created_at INTEGER, seq INTEGER, local_id TEXT, invoked_at INTEGER, scheduled_at INTEGER);
        CREATE TABLE users (id INTEGER PRIMARY KEY, platform TEXT, platform_user_id TEXT, namespace TEXT, created_at INTEGER);
        CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY, namespace TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, created_at INTEGER);
    `)
    db.run(`INSERT INTO machines (id, namespace, created_at, updated_at, metadata, metadata_version, runner_state, runner_state_version, active, active_at, seq) VALUES ('m1', 'default', 1700000000000, 1700000000001, '{"host":"example"}', 1, NULL, 1, 0, NULL, 0)`)
    db.run(`INSERT INTO sessions (id, tag, namespace, machine_id, created_at, updated_at, metadata, metadata_version, agent_state, agent_state_version, model, model_reasoning_effort, effort, service_tier, todos, todos_updated_at, team_state, team_state_updated_at, active, active_at, seq) VALUES ('sess-test', 'tag1', 'default', 'm1', 1700000000002, 1700000000003, '{"path":"/tmp"}', 1, NULL, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0)`)
    db.run(`INSERT INTO messages (id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at) VALUES ('msg-1', 'sess-test', '{"role":"user"}', 1700000000004, 1, 'loc-1', NULL, NULL)`)
    db.run(`INSERT INTO users (id, platform, platform_user_id, namespace, created_at) VALUES (1, 'telegram', '12345', 'default', 1700000000005)`)
    db.run(`INSERT INTO push_subscriptions (id, namespace, endpoint, p256dh, auth, created_at) VALUES (1, 'default', 'https://ep.example', 'p256', 'auth1', 1700000000006)`)
    db.run(`PRAGMA user_version = 10`)
    db.close()
}

describe('migrate-sqlite-to-postgres', () => {
    itPg('copies all tables and round-trips BIGINT created_at as a number', async () => {
        const admin = postgres(adminUrl(), { types: { bigint: bigintToNumber } })
        await admin.unsafe(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`)
        await admin.unsafe(`CREATE DATABASE ${ISOLATED_DB}`)
        await admin.end()

        const tmpDir = mkdtempSync(join(tmpdir(), 'hapi-migrate-'))
        const sqlitePath = join(tmpDir, 'hapi.db')
        buildSourceSqlite(sqlitePath)

        try {
            await migrateSqliteToPostgres({ sqlitePath, dstUrl: isolatedUrl(), force: true })

            const sql = postgres(isolatedUrl(), { types: { bigint: bigintToNumber } })
            try {
                const [{ n: machineCount }] = await sql`SELECT COUNT(*)::int AS n FROM machines`
                const [{ n: sessionCount }] = await sql`SELECT COUNT(*)::int AS n FROM sessions`
                const [{ n: messageCount }] = await sql`SELECT COUNT(*)::int AS n FROM messages`
                const [{ n: userCount }] = await sql`SELECT COUNT(*)::int AS n FROM users`
                const [{ n: pushCount }] = await sql`SELECT COUNT(*)::int AS n FROM push_subscriptions`
                expect(machineCount).toBe(1)
                expect(sessionCount).toBe(1)
                expect(messageCount).toBe(1)
                expect(userCount).toBe(1)
                expect(pushCount).toBe(1)

                // BIGINT guard: created_at must come back as a JS number, not a string.
                const [m1] = await sql`SELECT created_at, metadata FROM machines WHERE id = 'm1'`
                expect(typeof m1.created_at).toBe('number')
                expect(m1.created_at).toBe(1700000000000)
                expect(m1.metadata).toBe('{"host":"example"}')

                const [s] = await sql`SELECT created_at FROM sessions WHERE id = 'sess-test'`
                expect(s.created_at).toBe(1700000000002)
            } finally {
                await sql.end()
            }
        } finally {
            const cleanup = postgres(adminUrl(), { types: { bigint: bigintToNumber } })
            await cleanup.unsafe(`DROP DATABASE IF EXISTS ${ISOLATED_DB}`)
            await cleanup.end()
            rmSync(tmpDir, { recursive: true, force: true })
        }
    })

    itPg('refuses a non-V10 source', async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'hapi-migrate-'))
        const sqlitePath = join(tmpDir, 'hapi.db')
        const db = new Database(sqlitePath)
        db.run(`CREATE TABLE sessions (id TEXT)`) // user_version defaults to 0
        db.close()

        try {
            await expect(
                migrateSqliteToPostgres({ sqlitePath, dstUrl: isolatedUrl() })
            ).rejects.toThrow(/expected 10/)
        } finally {
            rmSync(tmpDir, { recursive: true, force: true })
        }
    })
})
