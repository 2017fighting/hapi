import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

import { SessionStore } from './pg/sessionStore'
import { MessageStore } from './pg/messageStore'
import { MachineStore } from './pg/machineStore'
import { UserStore } from './pg/userStore'
import { PushStore } from './pg/pushStore'

export type Sql = ReturnType<typeof postgres>

export interface StoreOptions {
    max?: number
    ssl?: 'require' | 'prefer' | 'disable'
    sql?: Sql // inject an existing pool (tests reuse one); Store will not own/end() it
}

const SCHEMA_VERSION = 1
const __dirname = dirname(fileURLToPath(import.meta.url))

// porsager 3.4.x has no `postgres.toNumber` shorthand and no built-in `bigint`
// type that returns a JS number (default returns string to avoid precision loss).
// BIGINT columns (epoch ms ~1.7e12, seq, etc.) are all within Number.MAX_SAFE_INTEGER,
// so we register a custom PostgresType that parses oid 20 (int8) to a JS number.
// This is the GLOBAL correctness guard: every connection this factory creates
// inherits it. Tests assert typeof === 'number' on a BIGINT round-trip.
export const bigintToNumber: postgres.PostgresType<number> = {
    to: 20,
    from: [20],
    serialize: (x) => '' + x,
    parse: (x) => Number(x),
}

function defaultSsl(connectionString: string): 'require' | 'prefer' | 'disable' {
    try {
        const { hostname } = new URL(connectionString)
        if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') {
            return 'disable'
        }
    } catch {
        // Not a parseable URL — fall through to conservative default.
    }
    return 'require'
}

export class Store {
    readonly sql: Sql
    private readonly ownsSql: boolean
    // Wired by wireStores() in Store.create() — definite-assignment asserted
    // because Object.assign populates these after the constructor returns.
    readonly sessions!: SessionStore
    readonly machines!: MachineStore
    readonly messages!: MessageStore
    readonly users!: UserStore
    readonly push!: PushStore

    private constructor(sql: Sql, ownsSql: boolean) {
        this.sql = sql
        this.ownsSql = ownsSql
    }

    static async create(connectionString: string, opts: StoreOptions = {}): Promise<Store> {
        const envSsl = process.env.DATABASE_SSL as 'require' | 'prefer' | 'disable' | undefined
        const mode: 'require' | 'prefer' | 'disable' = envSsl ?? opts.ssl ?? defaultSsl(connectionString)
        // 'disable' → undefined (no SSL); 'require'|'prefer' passes through directly.
        // porsager accepts `'require' | 'allow' | 'prefer' | 'verify-full' | boolean | object`,
        // so 'require' | 'prefer' | undefined is a strict subset — no cast needed.
        const ssl: 'require' | 'prefer' | undefined = mode === 'disable' ? undefined : mode
        const sql: Sql = opts.sql
            ?? postgres(connectionString, {
                max: opts.max ?? Number(process.env.DATABASE_MAX_CONNECTIONS ?? 10),
                ssl,
                types: { bigint: bigintToNumber }, // GLOBAL: BIGINT → number
            })
        const store = new Store(sql, opts.sql ? false : true)
        await store.initSchema()
        store.wireStores(sql)
        return store
    }

    private wireStores(sql: Sql): void {
        Object.assign(this, {
            sessions: new SessionStore(sql),
            machines: new MachineStore(sql),
            messages: new MessageStore(sql),
            users: new UserStore(sql),
            push: new PushStore(sql),
        })
    }

    private async initSchema(): Promise<void> {
        const schemaPath = resolve(__dirname, './schema.sql')
        const ddl = readFileSync(schemaPath, 'utf8')
        await this.sql.begin(async (tx) => {
            await tx.unsafe(ddl)
            await tx`
                INSERT INTO schema_migrations (version)
                VALUES (${SCHEMA_VERSION})
                ON CONFLICT (version) DO NOTHING
            `
        })
    }

    async close(): Promise<void> {
        if (this.ownsSql) await this.sql.end({ timeout: 5 })
    }
}
