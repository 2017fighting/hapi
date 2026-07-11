#!/usr/bin/env bun
/**
 * One-time migration: copy all data from a V10 SQLite hapi.db into a target
 * PostgreSQL database.
 *
 * The source SQLite file MUST be at user_version = 10 (run the current hub once
 * to auto-upgrade an older file, then retry). The target PG schema is applied
 * idempotently from src/store/schema.sql.
 *
 * Usage:
 *   bun run hub/scripts/migrate-sqlite-to-postgres.ts \
 *     --sqlite ~/.hapi/hapi.db \
 *     --to postgres://user:pass@host:5432/hapi \
 *     [--dry-run] [--force]
 *
 * --dry-run  Print the per-table row counts and exit without writing.
 * --force    Truncate the target tables before copying (otherwise refuse if
 *            the target already contains data).
 */

import { Database } from 'bun:sqlite' // read-only source side
import postgres from 'postgres'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bigintToNumber } from '../src/store/pgIndex'

export type MigrationOptions = {
    sqlitePath: string
    dstUrl: string
    force?: boolean
    dryRun?: boolean
}

const TABLES = ['users', 'push_subscriptions', 'machines', 'sessions', 'messages'] as const
const COLUMNS: Record<typeof TABLES[number], readonly string[]> = {
    users: ['id', 'platform', 'platform_user_id', 'namespace', 'created_at'],
    push_subscriptions: ['id', 'namespace', 'endpoint', 'p256dh', 'auth', 'created_at'],
    machines: ['id', 'namespace', 'created_at', 'updated_at', 'metadata', 'metadata_version', 'runner_state', 'runner_state_version', 'active', 'active_at', 'seq'],
    sessions: ['id', 'tag', 'namespace', 'machine_id', 'created_at', 'updated_at', 'metadata', 'metadata_version', 'agent_state', 'agent_state_version', 'model', 'model_reasoning_effort', 'effort', 'service_tier', 'todos', 'todos_updated_at', 'team_state', 'team_state_updated_at', 'active', 'active_at', 'seq'],
    messages: ['id', 'session_id', 'content', 'created_at', 'seq', 'local_id', 'invoked_at', 'scheduled_at'],
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DDL = readFileSync(resolve(__dirname, '../src/store/schema.sql'), 'utf8')

/**
 * Copy all rows from a V10 SQLite hapi.db into the target PostgreSQL database.
 * Throws on any precondition/verification failure (caller decides the exit code).
 */
export async function migrateSqliteToPostgres(opts: MigrationOptions): Promise<void> {
    const src = new Database(opts.sqlitePath, { readonly: true, strict: true })
    try {
        const versionRow = src.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
        const srcVersion = versionRow?.user_version ?? 0
        if (srcVersion !== 10) {
            throw new Error(`Source SQLite user_version is ${srcVersion}, expected 10. ` +
                'Run your current hub once to auto-upgrade, then retry.')
        }

        const sql = postgres(opts.dstUrl, { types: { bigint: bigintToNumber } })
        try {
            // Ensure target schema exists (inline schema.sql so the script is self-contained).
            await sql.begin(async (tx) => {
                await tx.unsafe(SCHEMA_DDL)
                await tx`INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`
            })

            if (!opts.force) {
                const [{ populated }] = await sql`SELECT EXISTS(SELECT 1 FROM sessions LIMIT 1) AS populated`
                if (populated) {
                    throw new Error('Target already has data. Re-run with --force to truncate first.')
                }
            } else {
                await sql`TRUNCATE messages, sessions, machines, users, push_subscriptions RESTART IDENTITY CASCADE`
            }

            const plan: string[] = []
            for (const table of TABLES) {
                const { count } = src.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
                plan.push(`${table}: ${count} rows`)
            }
            console.log('Migration plan:\n  ' + plan.join('\n  '))
            if (opts.dryRun && !opts.force) {
                console.log('\n--dry-run: no data written. Re-run with --force to apply.')
                return
            }

            const BATCH = 1000
            for (const table of TABLES) {
                const cols = COLUMNS[table]
                const total = (src.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
                let copied = 0
                while (copied < total) {
                    const rows = src.prepare(`SELECT ${cols.join(', ')} FROM ${table} LIMIT ${BATCH} OFFSET ${copied}`).all() as Record<string, unknown>[]
                    if (rows.length === 0) break
                    const colList = cols.join(', ')
                    await sql`INSERT INTO ${sql.unsafe(table)} (${sql.unsafe(colList)}) VALUES ${sql(rows.map((r) => cols.map((c) => r[c] ?? null)))}`
                    copied += rows.length
                    console.log(`  ${table}: ${copied}/${total}`)
                }
            }

            // Reset SERIAL sequences so future inserts don't collide.
            await sql`SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 0) FROM users))`
            await sql`SELECT setval('push_subscriptions_id_seq', (SELECT COALESCE(MAX(id), 0) FROM push_subscriptions))`

            // Verify counts.
            let mismatch = false
            for (const table of TABLES) {
                const sCount = (src.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
                const [{ dcount }] = await sql`SELECT COUNT(*)::int AS dcount FROM ${sql.unsafe(table)}`
                const ok = sCount === dcount
                console.log(`verify ${table}: src=${sCount} dst=${dcount} ${ok ? 'OK' : 'MISMATCH'}`)
                if (!ok) mismatch = true
            }
            if (mismatch) {
                throw new Error('Count mismatch — inspect target and re-run with --force after fixing.')
            }

            console.log('Migration complete.')
        } finally {
            await sql.end()
        }
    } finally {
        src.close()
    }
}

// CLI entry — only when run directly (not when imported by tests).
if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            sqlite: { type: 'string' },
            to: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            force: { type: 'boolean', default: false },
        },
    })

    if (!values.sqlite || !values.to) {
        console.error('usage: migrate-sqlite-to-postgres --sqlite <path> --to <DATABASE_URL> [--dry-run] [--force]')
        process.exit(2)
    }

    migrateSqliteToPostgres({
        sqlitePath: values.sqlite,
        dstUrl: values.to,
        force: values.force,
        dryRun: values['dry-run'],
    }).catch((err) => {
        console.error('Error:', err instanceof Error ? err.message : err)
        process.exit(1)
    })
}
