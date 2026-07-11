# PostgreSQL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `hub` package's SQLite storage with PostgreSQL end-to-end, preserving the existing Store architecture and all current behavior (verified by porting the existing test suite).

**Architecture:** Drop-in replacement of the data layer: `postgres` (porsager) raw driver replaces `bun:sqlite`; the 5 Store classes + 52 query functions keep their shape but become `async` and use Postgres SQL dialect; a `schema_migrations` table replaces `PRAGMA user_version`; a one-time `sqlite→postgres` script carries existing user data over.

**Tech Stack:** TypeScript, Bun (`bun test` + `bun:sqlite` for the migration script only), `postgres` (porsager) driver, PostgreSQL 16, Hono, socket.io, grammy.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-11-postgresql-support-design.md`):

- **Backend**: PostgreSQL only in `hub` runtime; `bun:sqlite` removed from hub runtime, kept solely as the migration script's read-side.
- **Driver**: `postgres` (porsager), raw SQL via tagged templates. No ORM / query builder.
- **`DATABASE_URL`** is **required** (fail-fast if absent). Optional env: `DATABASE_SSL` (`require`|`prefer`|`disable`; default `require` for non-localhost), `DATABASE_MAX_CONNECTIONS` (default 10).
- **BIGINT**: every SQLite `INTEGER` column holding epoch-ms timestamps, `seq`, `*_version`, or counts becomes Postgres **`BIGINT`** (32-bit `INTEGER` overflows in 2038). Configure `types: { bigint: postgres.toNumber }` globally so reads return JS `number`, not string.
- **`active`** stays `INTEGER DEFAULT 0` (no BOOLEAN conversion). JSON columns stay `TEXT` (no JSONB).
- **Migrations**: `schema_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())` replaces `PRAGMA user_version`. Fresh PG DB starts at schema version **1** (final V10 shape); the SQLite V1→V10 ladder is NOT replayed.
- **`cli`/`shared`/`web`** are untouched (only `hub` has a DB). `cli/src/opencode/utils/opencodeStorageScanner.ts` keeps reading OpenCode's own `opencode.db` read-only — do NOT touch it.
- Existing user data is preserved via the P5 migration script (requires source `user_version = 10`).

### Port Rules (SQLite/bun:sqlite → Postgres/porsager) — referenced by every P2 task

| # | SQLite pattern | Postgres / porsager |
|---|---|---|
| R1 | `import type { Database } from 'bun:sqlite'` | `import type { Sql } from 'postgres'` (see Task 3 for the `Sql` type alias) |
| R2 | `function f(db: Database, …)` | `async function f(sql: Sql, …)`; every call site adds `await` |
| R3 | `db.prepare('SELECT … WHERE id = ?').get(id)` | `const rows = await sql\`SELECT … WHERE id = ${id}\`; return rows[0]` |
| R4 | `db.prepare('SELECT …').all(…)` | `await sql\`SELECT …\`` (returns the row array) |
| R5 | `.run({ named: value })` named-object bind | tagged template with one `${value}` per value (porsager has no named-object bind) |
| R6 | `result.changes === 1` / `> 0` | `(await sql\`UPDATE/DELETE/INSERT …\`).count === 1` / `> 0` |
| R7 | `db.transaction(() => { … })()` | `await sql.begin(async tx => { … })` — use `tx` for statements inside |
| R8 | `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` manual tx | replace the whole block with one `await sql.begin(async tx => { … })` |
| R9 | dynamic `IN (${placeholders})` with `?` + array spread | `IN ${sql(ids)}` (porsager expands an array to `(v1, v2, …)`) |
| R10 | `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` |
| R11 | `col IS NOT @x` (SQLite NULL-safe not-equal) | `col IS DISTINCT FROM ${x}` (Postgres NULL-safe not-equal) |
| R12 | dynamic table/column name (internal enum only) | validate against an allowlist, then `sql.unsafe('"'+id+'"')` — never interpolate user data |
| R13 | `SELECT COUNT(*) AS count` → `{ count }` | works as-is once `bigint: toNumber` is set; cast `::int` for safety |
| R14 | `coalesce(null, …)` insert of literal via `?? null` | unchanged; pass JS `null` and porsager sends `NULL` |

**Correctness contract:** the existing `*.test.ts` files define behavior. For each P2 task, port the corresponding test file to `async` + `createTestStore()` FIRST (red), then port the implementation to pass (green). Do not invent new assertions.

---

## File Structure (decomposition locked in)

**New files:**
- `hub/src/store/schema.sql` — the full PG schema (§3 of spec) as one idempotent `CREATE TABLE IF NOT EXISTS` block.
- `hub/src/store/pgVersionedUpdates.ts` — async port of `versionedUpdates.ts` (foundational; handles dynamic identifiers).
- `hub/src/store/pg/{sessions,messages,machines,users,pushSubscriptions}.ts` — async PG ports (live alongside the old modules during P2; old modules deleted in P4).
- `hub/src/store/pg/{sessionStore,messageStore,machineStore,userStore,pushStore}.ts` — async Store-class ports.
- `hub/src/store/pgIndex.ts` — the async `Store` class with `Store.create()` factory + `schema_migrations` runner + `close()`.
- `hub/src/store/testStore.ts` — `createTestStore()` helper (shared pool + TRUNCATE-per-call).
- `hub/scripts/migrate-sqlite-to-postgres.ts` — one-time data migration tool.
- `hub/docker-compose.test.yml` — local `postgres:16` for tests.

**Modified:** `hub/src/store/index.ts` (barrel re-points to PG), `hub/src/configuration.ts` (`DATABASE_URL`), `hub/src/startHub.ts` (`await Store.create`), the 17 Store-consumer files (async propagation), `hub/package.json`, `.github/workflows/test.yml`, README/docs.

**Deleted (P4):** `hub/src/store/{sessions,messages,machines,users,pushSubscriptions,versionedUpdates,sessionStore,messageStore,machineStore,userStore,pushStore}.ts` (old SQLite impls), `hub/src/store/migration-v8.test.ts`, `hub/src/store/migration-v9.test.ts`, `hub/src/store/index.ts`'s SQLite `Store` class (replaced), `hub/src/cursor/cursorLegacyMigrator.ts` + fixtures, `DB_PATH`.

---

## Phase P1 — Infrastructure

### Task 1: Add `postgres` dependency + local test Postgres

**Files:**
- Modify: `hub/package.json`
- Create: `hub/docker-compose.test.yml`

**Interfaces:**
- Produces: `postgres` resolvable from `hub/src/**`; `docker compose -f hub/docker-compose.test.yml up` starts a `postgres:16` on `127.0.0.1:5432` with db/user/pass `hapitest`.

- [ ] **Step 1: Add the dependency**

In `hub/package.json`, inside `"dependencies"`, add (preserve existing key order/style):

```json
        "postgres": "^3.4.5",
```

Then:

```bash
cd /home/zhao/clone/hapi && bun install
```

Expected: install succeeds; `node_modules/postgres` exists.

- [ ] **Step 2: Create the test compose file**

`hub/docker-compose.test.yml`:

```yaml
services:
  postgres-test:
    image: postgres:16
    environment:
      POSTGRES_DB: hapitest
      POSTGRES_USER: hapitest
      POSTGRES_PASSWORD: hapitest
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U hapitest -d hapitest"]
      interval: 1s
      timeout: 3s
      retries: 30
```

- [ ] **Step 3: Smoke-test the driver connects**

```bash
docker compose -f hub/docker-compose.test.yml up -d --wait
cd hub && bun eval '
import postgres from "postgres"
const sql = postgres("postgres://hapitest:hapitest@127.0.0.1:5432/hapitest")
const [{ ok }] = await sql`SELECT 1 AS ok`
console.log("connected, ok =", ok)
await sql.end()
'
```

Expected: prints `connected, ok = 1`.

- [ ] **Step 4: Commit**

```bash
git add hub/package.json hub/docker-compose.test.yml bun.lockb
git commit -m "feat(hub): add postgres(porsager) dep + local test compose"
```

---

### Task 2: Postgres service in CI + `TEST_DATABASE_URL`

**Files:**
- Modify: `.github/workflows/test.yml:7-27`

**Interfaces:**
- Produces: CI exposes `TEST_DATABASE_URL=postgres://hapitest:hapitest@localhost:5432/hapitest` to `bun run test`.

- [ ] **Step 1: Add the service + env**

Replace the `jobs.test` block (`.github/workflows/test.yml:7-27`) with:

```yaml
jobs:
    test:
        runs-on: ubuntu-latest
        services:
            postgres:
                image: postgres:16
                env:
                    POSTGRES_DB: hapitest
                    POSTGRES_USER: hapitest
                    POSTGRES_PASSWORD: hapitest
                ports:
                    - 5432:5432
                options: >-
                    --health-cmd "pg_isready -U hapitest -d hapitest"
                    --health-interval 1s
                    --health-timeout 3s
                    --health-retries 30
        env:
            TEST_DATABASE_URL: postgres://hapitest:hapitest@localhost:5432/hapitest
        steps:
            - uses: actions/checkout@v4
            - uses: oven-sh/setup-bun@v2
              with:
                  bun-version: 1.3.14
            - run: bun install
            - run: bun typecheck
            - name: Create integration test env
              run: |
                  {
                      echo "HAPI_HOME=~/.hapi-dev-test"
                      echo "HAPI_API_URL=http://localhost:3006"
                      echo "CLI_API_TOKEN=${CLI_API_TOKEN:-dev-test-token}"
                      echo "HAPI_DAEMON_HTTP_TIMEOUT=60000"
                      echo "HAPI_DAEMON_HEARTBEAT_INTERVAL=30000"
                  } > cli/.env.integration-test
            - run: bun run test
```

- [ ] **Step 2: Verify locally with the same env**

```bash
export TEST_DATABASE_URL=postgres://hapitest:hapitest@127.0.0.1:5432/hapitest
bun run test:hub
```

Expected: tests run (still SQLite-backed at this point; the env is present but unused — no failures caused by the workflow edit).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci(hub): add postgres:16 service + TEST_DATABASE_URL for tests"
```

---

### Task 3: PG schema file + `Store.create()` factory + BIGINT parser

**Files:**
- Create: `hub/src/store/schema.sql`
- Create: `hub/src/store/pgIndex.ts`
- Create: `hub/src/store/pgIndex.test.ts`

**Interfaces:**
- Produces:
  - `Sql` type alias exported from `pgIndex.ts`: `export type Sql = ReturnType<typeof import('postgres').default>`
  - `export class Store { static async create(connectionString: string, opts?: { max?: number; ssl?: 'require'|'prefer'|'disable'; sql?: Sql }): Promise<Store>; readonly sql; async close(): Promise<void> }` (the `sessions/machines/messages/users/push` fields are wired in Task 10).
  - `Store.create` reads `hub/src/store/schema.sql`, applies it inside `sql.begin`, inserts/ignores `schema_migrations` version 1.
  - The `bigint → Number` parser is configured on every connection this factory creates.

- [ ] **Step 1: Write the schema file**

`hub/src/store/schema.sql` — paste the full schema from spec §3 (the `schema_migrations` + 5 tables + all indexes), exactly as written there. It is a single script of `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements, idempotent.

- [ ] **Step 2: Write the failing test (BIGINT guard is the point)**

`hub/src/store/pgIndex.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import postgres from 'postgres'
import { Store } from './pgIndex'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

describe('Store.create (Postgres)', () => {
    itPg('applies schema and returns BIGINT as JS number', async () => {
        const sql = postgres(TEST_URL!, { types: { bigint: postgres.toNumber } })
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
```

- [ ] **Step 3: Run the test — verify it fails**

```bash
cd hub && bun test src/store/pgIndex.test.ts
```

Expected: FAIL (`Store` / `pgIndex` not found).

- [ ] **Step 4: Implement `pgIndex.ts`**

```ts
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

export type Sql = ReturnType<typeof postgres>

export interface StoreOptions {
    max?: number
    ssl?: 'require' | 'prefer' | 'disable'
    sql?: Sql // inject an existing pool (tests reuse one); Store will not own/end() it
}

const SCHEMA_VERSION = 1
const __dirname = dirname(fileURLToPath(import.meta.url))

function defaultSsl(connectionString: string): 'require' | 'prefer' | 'disable' {
    if (/(^|\s)(127\.0\.0\.1|localhost)(:|\/)/.test(connectionString)) return 'disable'
    return 'require'
}

export class Store {
    readonly sql: Sql
    private readonly ownsSql: boolean
    // Wired in Task 10; typed loosely until then.
    readonly sessions: unknown
    readonly machines: unknown
    readonly messages: unknown
    readonly users: unknown
    readonly push: unknown

    private constructor(sql: Sql, ownsSql: boolean) {
        this.sql = sql
        this.ownsSql = ownsSql
    }

    static async create(connectionString: string, opts: StoreOptions = {}): Promise<Store> {
        const mode = process.env.DATABASE_SSL ?? opts.ssl ?? defaultSsl(connectionString)
        const ssl = mode === 'disable' ? undefined : mode
        const sql: Sql = opts.sql
            ?? postgres(connectionString, {
                max: opts.max ?? Number(process.env.DATABASE_MAX_CONNECTIONS ?? 10),
                ssl: ssl as postgres.Options<{}>['ssl'],
                types: { bigint: postgres.toNumber }, // GLOBAL: BIGINT → number
            })
        const store = new Store(sql, opts.sql ? false : true)
        await store.initSchema()
        return store
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
```

> **Embedding `schema.sql`:** `bun build` bundles `src/`. `readFileSync` at runtime needs the file adjacent to the bundle. For the dev/`bun run` path it works as-is. For the compiled `dist` build, Task 14 adds a build step that copies `schema.sql` next to the bundle (or inlines it as a string export). For now, runtime file read is correct for tests.

- [ ] **Step 5: Run the test — verify it passes**

```bash
cd hub && bun test src/store/pgIndex.test.ts
```

Expected: PASS (schema applied, BIGINT read as number, version=1).

- [ ] **Step 6: Commit**

```bash
git add hub/src/store/schema.sql hub/src/store/pgIndex.ts hub/src/store/pgIndex.test.ts
git commit -m "feat(hub): PG Store.create factory + schema.sql + BIGINT→Number parser"
```

---

### Task 4: `createTestStore()` helper + skip guard

**Files:**
- Create: `hub/src/store/testStore.ts`
- Create: `hub/src/store/testStore.test.ts`

**Interfaces:**
- Produces: `export async function createTestStore(): Promise<Store>` — returns a `Store` backed by a process-level singleton pool (`TEST_DATABASE_URL`), with all 5 tables TRUNCATED before returning. When `TEST_DATABASE_URL` is unset, the helper throws an explanatory error; tests that need PG use the `itPg = TEST_URL ? it : it.skip` pattern.

- [ ] **Step 1: Write the helper**

```ts
import postgres from 'postgres'
import { Store, type Sql } from './pgIndex'

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
        const sql = postgres(TEST_URL, { types: { bigint: postgres.toNumber } })
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
```

- [ ] **Step 2: Write a guard test**

`hub/src/store/testStore.test.ts`:

```ts
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
```

- [ ] **Step 3: Run — verify pass**

```bash
cd hub && bun test src/store/testStore.test.ts
```

Expected: PASS (skip if no `TEST_DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add hub/src/store/testStore.ts hub/src/store/testStore.test.ts
git commit -m "test(hub): createTestStore() helper — shared PG pool + TRUNCATE isolation"
```

---

## Phase P2 — Port the query layer (in `hub/src/store/pg/`)

> All P2 code lives under `hub/src/store/pg/` and is unit-tested in isolation. The **old** SQLite modules under `hub/src/store/*.ts` remain in place and still serve production until P4. P2 tasks are independently green.

### Task 5: Port `versionedUpdates` (foundational — dynamic identifiers)

**Files:**
- Create: `hub/src/store/pgVersionedUpdates.ts`
- Create: `hub/src/store/pgVersionedUpdates.test.ts`

**Interfaces:**
- Consumes: `Sql` from `pgIndex.ts`.
- Produces: `export async function updateVersionedField<T>(args: { sql: Sql; table: 'sessions'|'machines'; id: string; namespace: string; field: string; versionField: string; expectedVersion: number; value: T; encode: (v: T) => string|null; decode: (v: string|null) => T; }): Promise<VersionedUpdateResult<T>>` (import `VersionedUpdateResult` from `../types`).

> **Why this task is special:** the SQLite version builds SQL by string-interpolating `table`/`field`/`versionField`. Those are an internal fixed enum, never user data. **Recommendation: drop the generic `setClauses` mechanism** and have callers (Tasks 6–7) inline their extra SET columns into a bespoke UPDATE that calls this helper for the field+version bump only. This avoids fiddly dynamic-SQL composition.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import { updateVersionedField } from './pgVersionedUpdates'
import type { Sql } from '../pgIndex'

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
            encode: (v) => v, decode: (v) => v,
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
            expectedVersion: 1, value: '{"a":2}', encode: (v) => v, decode: (v) => v,
        })
        expect(r.result).toBe('version-mismatch')
        if (r.result === 'version-mismatch') expect(r.version).toBe(5)
    })
})
```

- [ ] **Step 2: Run — verify fail**

```bash
cd hub && bun test src/store/pgVersionedUpdates.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { Sql } from '../pgIndex'
import type { VersionedUpdateResult } from '../types'

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
```

> Callers needing extra SET columns (`updated_at`, `seq`, `active`) run their own UPDATE with the same `WHERE … AND versionField = expectedVersion` guard and the same success/mismatch/error interpretation. `seq = seq + 1` is a valid PG expression. See Task 6 for the concrete caller pattern.

- [ ] **Step 4: Run — verify pass**

```bash
cd hub && bun test src/store/pgVersionedUpdates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hub/src/store/pgVersionedUpdates.ts hub/src/store/pgVersionedUpdates.test.ts
git commit -m "feat(hub): PG async port of versionedUpdates (dynamic-identifier-safe)"
```

---

### Task 6: Port `sessions` + `SessionStore` + port `sessions.test.ts`

**Files:**
- Create: `hub/src/store/pg/sessions.ts`
- Create: `hub/src/store/pg/sessionStore.ts`
- Create: `hub/src/store/pg/sessions.test.ts` (port of `hub/src/store/sessions.test.ts`)

**Interfaces:**
- Consumes: `Sql` from `pgIndex.ts`; `updateVersionedField` from `../pgVersionedUpdates.ts`; `mergeSessionMetadata` — copy verbatim from `../sessions.ts` (pure function, no DB; re-export it).
- Produces: async versions of all 16 functions: `getOrCreateSession, updateSessionMetadata, updateSessionAgentState, setSessionTodos, setSessionTeamState, setSessionModel, setSessionModelReasoningEffort, setSessionEffort, setSessionServiceTier, touchSessionUpdatedAt, getSession, getSessionByNamespace, getSessions, getSessionsByNamespace, deleteSession`. Signatures: same params as today with `sql: Sql` replacing `db: Database`, all returning `Promise<…>`. `SessionStore` methods mirror them with `async`/`await`.

- [ ] **Step 1: Port the test file (red first)**

Copy `hub/src/store/sessions.test.ts` → `hub/src/store/pg/sessions.test.ts`. Apply these mechanical edits:
- `import { Store } from '../index'` → `import { createTestStore } from '../testStore'`.
- `function makeStore(): Store { return new Store(':memory:') }` → `async function makeStore() { return await createTestStore() }`.
- Add `await` before every `makeStore()` and every `store.sessions.X(…)` / `store.X(…)` call.
- Wrap with `const itPg = process.env.TEST_DATABASE_URL ? it : it.skip` and use `itPg` in place of `it`.

Do NOT change any assertion logic — the assertions are the correctness contract.

- [ ] **Step 2: Run — verify fail**

```bash
cd hub && bun test src/store/pg/sessions.test.ts
```

Expected: FAIL (modules not found).

- [ ] **Step 3: Port `sessions.ts`**

Create `hub/src/store/pg/sessions.ts` by copying `hub/src/store/sessions.ts` and applying the **Port Rules (R1–R14)**. Specific translations:

- `mergeSessionMetadata`, `isPlainObject`, `carryForwardIfMissing`, `preserveCursorProtocolPair`, the three field-name arrays — copy verbatim (pure logic, no DB).
- `DbSessionRow` — keep the snake_case shape; BIGINT columns come back as JS `number` (Task 3 parser).
- `toStoredSession` — unchanged (`row.active === 1` still works since `active` stays INTEGER).
- `getOrCreateSession` (R2, R3, R5): existence SELECT → `const rows = await sql\`SELECT * FROM sessions WHERE tag = ${tag} AND namespace = ${namespace} ORDER BY created_at DESC LIMIT 1\`; const existing = rows[0] as DbSessionRow | undefined`. INSERT → `await sql\`INSERT INTO sessions (id, tag, namespace, machine_id, created_at, updated_at, metadata, metadata_version, agent_state, agent_state_version, model, model_reasoning_effort, effort, todos, todos_updated_at, team_state, team_state_updated_at, active, active_at, seq) VALUES (${id}, ${tag}, ${namespace}, NULL, ${now}, ${now}, ${metadataJson}, 1, ${agentStateJson}, 1, ${model ?? null}, ${modelReasoningEffort ?? null}, ${effort ?? null}, NULL, NULL, 0, NULL, 0)\``. Trailing `getSession(db, id)` → `return await getSession(sql, id)`.
- `updateSessionMetadata` (R7): the `db.transaction(() => { … })()` wraps a `mergeSessionMetadata` call + versioned write. Replace with a bespoke UPDATE inside `await sql.begin(async tx => { … })`: SELECT prior metadata, compute merged value, `UPDATE sessions SET metadata = $merged, metadata_version = metadata_version + 1, updated_at = CASE … END, seq = seq + 1 WHERE id = $id AND namespace = $namespace AND metadata_version = $expectedVersion`. If `.count === 1` → success (version = expected+1). Else SELECT current version+value → return `version-mismatch` (or `error` if row missing). Wrap in `try/catch → { result: 'error' }`.
- The six `setSession*` functions (R5, R6, R11): each a parameterized UPDATE. SQLite `col IS NOT @x` → `col IS DISTINCT FROM ${x}` (R11). `result.changes === 1` → `(await sql\`…\`).count === 1` (R6). Keep each wrapped in `try { … } catch { return false }`.
- `setSessionTodos` / `setSessionTeamState` — same UPDATE shape; `CASE WHEN … THEN … ELSE … END` is valid PG; keep it.
- `getSession`, `getSessionByNamespace`, `getSessions`, `getSessionsByNamespace`, `deleteSession` (R3, R4, R6): direct translations; `deleteSession`'s `result.changes > 0` → `(await sql\`DELETE …\`).count > 0`.

- [ ] **Step 4: Port `sessionStore.ts`**

Copy `hub/src/store/sessionStore.ts` → `hub/src/store/pg/sessionStore.ts`:
- `import type { Database } from 'bun:sqlite'` → `import type { Sql } from '../pgIndex'`.
- `private readonly db: Database` → `private readonly sql: Sql`; constructor `(db: Database)` → `(sql: Sql)`.
- Every method: add `async`, `this.db` → `this.sql`, `return fn(this.db, …)` → `return await fn(this.sql, …)`.

- [ ] **Step 5: Run — verify pass**

```bash
cd hub && bun test src/store/pg/sessions.test.ts
```

Expected: PASS (all ported assertions green).

- [ ] **Step 6: Commit**

```bash
git add hub/src/store/pg/sessions.ts hub/src/store/pg/sessionStore.ts hub/src/store/pg/sessions.test.ts
git commit -m "feat(hub): PG async port of sessions + SessionStore (16 functions)"
```

---

### Task 7: Port `machines` + `MachineStore` + tests

**Files:**
- Create: `hub/src/store/pg/machines.ts`
- Create: `hub/src/store/pg/machineStore.ts`
- Create: `hub/src/store/pg/machines.test.ts` (port machine coverage if present; else write a minimal one mirroring the session test's `getOrCreate`/`updateMachineMetadata`/version-mismatch shape)

**Interfaces:**
- Consumes: `Sql`; `updateVersionedField` from `../pgVersionedUpdates.ts`.
- Produces: async `getOrCreateMachine, updateMachineMetadata, updateMachineRunnerState, getMachine, getMachineByNamespace, getMachines, getMachinesByNamespace`; `MachineStore` mirrors them.

- [ ] **Step 1: Port the test (red)** — same mechanical recipe as Task 6 Step 1 (`createTestStore`, `await`, `itPg`).
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Port `machines.ts`** — apply Port Rules. The versioned calls (`updateMachineMetadata`, `updateMachineRunnerState`) use the bespoke-UPDATE pattern from Task 6 Step 3 (`updateMachineRunnerState` also sets `active = 1, active_at = $now`). `getOrCreateMachine` checks namespace mismatch and throws (keep that).
- [ ] **Step 4: Port `machineStore.ts`** — same recipe as `sessionStore` (Task 6 Step 4).
- [ ] **Step 5: Run — verify pass.**
- [ ] **Step 6: Commit**

```bash
git add hub/src/store/pg/machines.ts hub/src/store/pg/machineStore.ts hub/src/store/pg/machines.test.ts
git commit -m "feat(hub): PG async port of machines + MachineStore (7 functions)"
```

---

### Task 8: Port `messages` + `MessageStore` + tests (the complex one)

**Files:**
- Create: `hub/src/store/pg/messages.ts`
- Create: `hub/src/store/pg/messageStore.ts`
- Create: `hub/src/store/pg/messages.test.ts` (port of `hub/src/store/messages.test.ts`)

**Interfaces:**
- Consumes: `Sql`.
- Produces: async versions of all 20 functions: `addMessage, copyMessageToSession, getMessages, getAllMessages, getFirstMessages, getDeliverableMessagesAfter, getMessagesByPosition, getUninvokedLocalMessages, getMatureScheduledMessages, getImmediateQueuedLocalMessages, countMessages, countFutureScheduledLocalMessages, countFutureScheduledBySessionIds, minFutureScheduledAtBySessionIds, getMaxSeq, cancelQueuedMessage, lookupQueuedMessage, deleteQueuedMessageById, markMessagesInvoked, mergeSessionMessages`. `MessageStore` mirrors them. The exported result types `CancelQueuedMessageResult`, `LookupQueuedMessageResult`, `CopyStoredMessageInput` are copied verbatim.

**Special translations beyond the base rules:**
- **Dynamic `IN (${placeholders})` (R9)** — appears in `countFutureScheduledBySessionIds`, `minFutureScheduledAtBySessionIds`, `markMessagesInvoked`, `mergeSessionMessages`'s collision UPDATE. SQLite builds `ids.map(() => '?').join(',')` then spreads. PG: `IN ${sql(ids)}` — porsager expands the array. The `now`/extra param stays a separate `${now}`.
- **`db.transaction(() => …)()` (R7)** — `cancelQueuedMessage`. Replace with `await sql.begin(async tx => { …; return <result> })`.
- **`mergeSessionMessages` manual `BEGIN/COMMIT/ROLLBACK` (R8)** — becomes one `await sql.begin(async tx => { … })`; the surrounding `try/catch` is dropped (`sql.begin` rolls back on throw and rethrows).
- **`getMessagesByPosition` dynamic `beforeClause`** — SQLite conditionally interpolates a string. PG: branch into two static templates: `if (before) { rows = await sql\`… AND (COALESCE(invoked_at, created_at) < ${before.at} OR (COALESCE(invoked_at, created_at) = ${before.at} AND seq < ${before.seq})) ORDER BY position_at DESC, seq DESC LIMIT ${safeLimit}\` } else { rows = await sql\`… ORDER BY position_at DESC, seq DESC LIMIT ${safeLimit}\` }`. Do NOT build SQL by string concatenation.
- **`addMessage` seq computation** — `SELECT COALESCE(MAX(seq),0)+1` works in PG unchanged; returned as a number (bigint parser).

- [ ] **Step 1: Port `messages.test.ts` → `hub/src/store/pg/messages.test.ts`** (same recipe: `createTestStore`, `await`, `itPg`; assertions unchanged).
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Port `messages.ts`** applying Port Rules + the 4 special cases above. Verify each `IN` clause uses `sql(array)`, each transaction uses `sql.begin`, and `getMessagesByPosition` uses the branch-not-concat pattern.
- [ ] **Step 4: Port `messageStore.ts`** (same recipe as Task 6 Step 4).
- [ ] **Step 5: Run — verify pass**

```bash
cd hub && bun test src/store/pg/messages.test.ts
```

Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add hub/src/store/pg/messages.ts hub/src/store/pg/messageStore.ts hub/src/store/pg/messages.test.ts
git commit -m "feat(hub): PG async port of messages + MessageStore (20 functions, IN/tx/byPosition)"
```

---

### Task 9: Port `users` + `pushSubscriptions` + `UserStore` + `PushStore` + tests

**Files:**
- Create: `hub/src/store/pg/users.ts`, `hub/src/store/pg/userStore.ts`
- Create: `hub/src/store/pg/pushSubscriptions.ts`, `hub/src/store/pg/pushStore.ts`
- Create: `hub/src/store/pg/users.test.ts`, `hub/src/store/pg/pushSubscriptions.test.ts`

**Interfaces:**
- Produces:
  - users async: `getUser, getUsersByPlatform, getUsersByPlatformAndNamespace, addUser, removeUser`; `UserStore`.
  - push async: `addPushSubscription, removePushSubscription, getPushSubscriptionsByNamespace`; `PushStore`.

**Special translations:**
- **`INSERT OR IGNORE` (R10)** in `addUser` → `INSERT INTO users (…) VALUES (…) ON CONFLICT (platform, platform_user_id) DO NOTHING`.
- **`ON CONFLICT … DO UPDATE SET …`** in `addPushSubscription` — SQLite's UPSERT syntax is already PG-compatible (`ON CONFLICT(namespace, endpoint) DO UPDATE SET p256dh = excluded.p256dh, …`). Keep the clause, switch to template params (`excluded` is valid PG).
- `users.id` / `push_subscriptions.id` are `SERIAL` — inserts must NOT specify `id`; the DB assigns it. (The SQLite code already omits `id`; verify both ports do too.)
- `result.changes > 0` (R6) in `removeUser` → `.count > 0`.

- [ ] **Step 1: Port both test files (red)** — same recipe.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Port `users.ts` + `pushSubscriptions.ts`** applying R5/R6/R10.
- [ ] **Step 4: Port `userStore.ts` + `pushStore.ts`** (same recipe).
- [ ] **Step 5: Run — verify pass.**
- [ ] **Step 6: Commit**

```bash
git add hub/src/store/pg/users.ts hub/src/store/pg/userStore.ts hub/src/store/pg/pushSubscriptions.ts hub/src/store/pg/pushStore.ts hub/src/store/pg/users.test.ts hub/src/store/pg/pushSubscriptions.test.ts
git commit -m "feat(hub): PG async port of users + pushSubscriptions + Stores (8 functions)"
```

---

## Phase P3 — Flip to the async PG Store and propagate `await` through consumers

> ⚠️ **P3 is one logical change split into reviewable commits.** The instant Task 10 re-points the barrel, every consumer is typebroken (sync→async). The full `bun run test:hub` suite goes red and is restored green only at the end of Task 14. Each task here is a coherent, individually-committable slice; do not expect the full suite green until Task 14. Run only the specific test file(s) each task touches, plus `bun typecheck` to track remaining breakage.

### Task 10: Wire PG Store classes into `pgIndex.ts` + flip the barrel

**Files:**
- Modify: `hub/src/store/pgIndex.ts` (wire `sessions`/`machines`/`messages`/`users`/`push`)
- Modify: `hub/src/store/index.ts` (re-export from PG; remove the SQLite `Store` class)

**Interfaces:**
- Produces: `hub/src/store/index.ts` now `export { Store } from './pgIndex'` and re-exports the `pg/` Store classes. The old synchronous `Store` is gone. **All consumers of `import { Store } from '…/store'` now get the async `Store`** — typecheck fails across the 17 consumer files (expected; Tasks 11–14 fix them).

- [ ] **Step 1: Wire Store classes into `pgIndex.ts`**

In `Store.create`, after `await store.initSchema()`, import the PG Store classes (`SessionStore` etc. from `./pg/sessionStore`) and assign `Object.assign(store, { sessions: new SessionStore(sql), machines: new MachineStore(sql), … })` — or convert the `readonly sessions: unknown` fields to typed fields set in a private `wireStores()`. Change the five `unknown` fields to their real types.

- [ ] **Step 2: Flip the barrel**

Replace the **contents** of `hub/src/store/index.ts` with re-exports only:

```ts
export { Store } from './pgIndex'
export type { Sql, StoreOptions } from './pgIndex'
export { SessionStore } from './pg/sessionStore'
export { MessageStore } from './pg/messageStore'
export { MachineStore } from './pg/machineStore'
export { UserStore } from './pg/userStore'
export { PushStore } from './pg/pushStore'
export type {
    StoredMachine, StoredMessage, StoredPushSubscription,
    StoredSession, StoredUser, VersionedUpdateResult,
} from './types'
export type { CancelQueuedMessageResult, CopyStoredMessageInput, LookupQueuedMessageResult } from './pg/messages'
```

(The old SQLite `Store` class, `initSchema`, the V1→V10 ladder, `createSchema`, PRAGMA helpers — all removed.)

- [ ] **Step 3: Run typecheck to enumerate the breakage**

```bash
cd hub && bun typecheck 2>&1 | tee /tmp/p3-breakage.txt | head -60
```

Expected: a list of errors across the 17 consumer files + their tests (`store.X(...)` not awaited, `new Store(':memory:')` invalid, etc.). This list IS the work backlog for Tasks 11–14.

- [ ] **Step 4: Commit (red, expected)**

```bash
git add hub/src/store/pgIndex.ts hub/src/store/index.ts
git commit -m "refactor(hub): flip Store barrel to async PG backend (P3; consumers red — fixed in Tasks 11-14)"
```

---

### Task 11: Propagate async through the cache layer

**Files:**
- Modify: `hub/src/sync/sessionCache.ts` (52KB)
- Modify: `hub/src/sync/machineCache.ts` (8KB)
- Modify: their tests

**Interfaces:**
- Consumes: async `SessionStore` / `MachineStore` from `../store`.
- Produces: async `sessionCache` / `machineCache` methods (write-through cache; reads become `async`).

- [ ] **Step 1:** Open `sessionCache.ts`. For every method, change signature to `async`, add `await` before each `this.store.sessions.X(…)` / `this.store.machines.X(…)` call. In-memory cache-map lookups stay sync; only DB misses acquire `await`.
- [ ] **Step 2:** Do the same for `machineCache.ts`.
- [ ] **Step 3:** Port `sessionCache`/`machineCache` tests: `createTestStore`, `await` on every cache + store call. Assertions unchanged.
- [ ] **Step 4:** Run those tests + typecheck the two files.

```bash
cd hub && bun test src/sync/sessionCache.test.ts src/sync/machineCache.test.ts && bun typecheck 2>&1 | grep -E 'sessionCache|machineCache' | head
```

Expected: targeted tests PASS; the two files have no new typecheck errors.
- [ ] **Step 5: Commit**

```bash
git add hub/src/sync/sessionCache.ts hub/src/sync/machineCache.ts hub/src/sync/sessionCache.test.ts hub/src/sync/machineCache.test.ts
git commit -m "refactor(hub): sessionCache + machineCache → async (P3 layer 2)"
```

---

### Task 12: Propagate async through the business layer

**Files:**
- Modify: `hub/src/sync/syncEngine.ts` (72KB), `hub/src/sync/messageService.ts` (28KB), `hub/src/sync/rpcGateway.ts` (3.8KB)
- Modify: `hub/src/sync/teams.ts`, `hub/src/sync/todos.ts` if they touch the store
- Modify: their tests

- [ ] **Step 1:** For `syncEngine.ts`, `messageService.ts`, `rpcGateway.ts`, `teams.ts`, `todos.ts`: add `async` to every function/method that transitively calls the store, and `await` at each store/cache call site. Do not alter branching, ordering, or business logic — purely adding `async`/`await`. (For versioned-write call sites that read the three-state result, the result is now `await`-ed before the `switch`.)
- [ ] **Step 2:** Port the corresponding tests (`messageService.test.ts` 57KB, `rpcGateway.test.ts`, `teams.test.ts`) to `await` + `createTestStore`. Assertions unchanged.
- [ ] **Step 3:** Run those tests.

```bash
cd hub && bun test src/sync/messageService.test.ts src/sync/rpcGateway.test.ts src/sync/teams.test.ts
```

Expected: PASS. (`syncEngine`'s full test may depend on socket/route wiring from Task 13 — run what is independently green.)
- [ ] **Step 4: Commit**

```bash
git add hub/src/sync/
git commit -m "refactor(hub): syncEngine + messageService + rpcGateway + teams → async (P3 layer 3)"
```

---

### Task 13: Propagate async through HTTP routes + socket.io handlers + bots

**Files:**
- Modify (routes): `hub/src/web/routes/auth.ts`, `bind.ts`, `push.ts`, `codexDesktop.ts`, `cli.ts`, `sessions.ts` — every route that calls the store.
- Modify (socket): `hub/src/socket/handlers/cli/sessionHandlers.ts`, `machineHandlers.ts`, `hub/src/socket/handlers/cli/index.ts`, plus any other handler under `hub/src/socket/handlers/` that calls `store.*`.
- Modify: `hub/src/telegram/bot.ts`, `hub/src/push/pushService.ts`.
- Modify: their tests.

**Socket handler pattern (REQUIRED — try/catch):** socket.io ignores the returned promise of an `async` handler, so an unhandled rejection would silently vanish. Wrap every store-touching handler:

```ts
socket.on('message', async (data: unknown) => {
    try {
        // … existing body, with `await` before each store.* / cache.* call …
    } catch (error) {
        socket.emit('error', { message: error instanceof Error ? error.message : 'internal error' })
        logger.error({ error }, 'socket handler failed')
    }
})
```

Apply this to every `socket.on(…)` that calls the store. The catch is the only addition for previously-void handlers; ensure any client-facing emit still happens in both branches.

**Route pattern:** Hono handlers are already async-capable — add `async` where missing and `await` before each store call. Errors propagate to Hono's error handler as before.

- [ ] **Step 1:** Convert all socket handlers under `hub/src/socket/handlers/` using the pattern above. The biggest is `sessionHandlers.ts` (365 lines, ~8 `socket.on` calls) — go handler-by-handler.
- [ ] **Step 2:** Convert the routes listed above (`await` + `async`).
- [ ] **Step 3:** Convert `telegram/bot.ts` (grammy is async-native; add `await`) and `push/pushService.ts`.
- [ ] **Step 4:** Port affected route/handler tests to `await` + `createTestStore`. Run them.
- [ ] **Step 5: Commit**

```bash
git add hub/src/socket/ hub/src/web/routes/ hub/src/telegram/ hub/src/push/
git commit -m "refactor(hub): routes + socket.io handlers + bots → async; socket try/catch (P3 layer 4)"
```

---

### Task 14: `startHub` wiring + restore full suite green

**Files:**
- Modify: `hub/src/startHub.ts:167`
- Modify: `hub/src/web/server.ts`, `hub/src/socket/server.ts` (Store construction/`close()` sites)

**Interfaces:**
- Produces: `startHub` constructs `const store = await Store.create(config.databaseUrl)`; shutdown calls `await store.close()`.

- [ ] **Step 1:** In `startHub.ts`, change `const store = new Store(config.dbPath)` → `const store = await Store.create(process.env.DATABASE_URL!)` (Task 15 swaps `process.env.DATABASE_URL!` → `config.databaseUrl`). `startHub` is already `async`.
- [ ] **Step 2:** Find every `store.close()` / `new Store(` call (`web/server.ts`, `socket/server.ts`, scripts) and `await` it / replace with `await Store.create(…)`.
- [ ] **Step 3: Run the FULL suite + typecheck — must be green**

```bash
cd hub && bun typecheck && bun test
```

Expected: PASS, zero typecheck errors. Remaining errors are leftover sync call sites — fix them (the `/tmp/p3-breakage.txt` list from Task 10 is the checklist).
- [ ] **Step 4: Commit**

```bash
git add hub/src/startHub.ts hub/src/web/server.ts hub/src/socket/server.ts
git commit -m "refactor(hub): startHub → Store.create(DATABASE_URL); full suite green on PG (P3 complete)"
```

---

## Phase P4 — Configuration switch + delete SQLite

### Task 15: `DATABASE_URL` in `configuration.ts`, remove `DB_PATH`

**Files:**
- Modify: `hub/src/configuration.ts:23` (doc comment), `:79` (field), `:99/104` (ctor params), `:147-149` (resolution)
- Modify: `hub/src/startHub.ts` (use `config.databaseUrl`)

- [ ] **Step 1:** Replace the `DB_PATH` doc line (`configuration.ts:23`) with:

```
 * - DATABASE_URL: PostgreSQL connection string (required, e.g. postgres://user:pass@host:5432/db)
```

- [ ] **Step 2:** Replace the field `public readonly dbPath: string` (`:79`) with `public readonly databaseUrl: string`.
- [ ] **Step 3:** Update the constructor signature/assignment (`:99/104`): `dbPath: string` → `databaseUrl: string`; `this.dbPath = dbPath` → `this.databaseUrl = databaseUrl`.
- [ ] **Step 4:** Replace the resolution block (`:146-149`):

```ts
        // 2. Require DATABASE_URL (env only - not persisted)
        const databaseUrl = process.env.DATABASE_URL
        if (!databaseUrl) {
            throw new Error(
                'DATABASE_URL is required. Set it to a PostgreSQL connection string, ' +
                'e.g. postgres://user:pass@host:5432/hapi'
            )
        }
```

And the `new Configuration(...)` call (`:159-164`) — pass `databaseUrl` instead of `dbPath`.
- [ ] **Step 5:** In `startHub.ts`, change `Store.create(process.env.DATABASE_URL!)` (Task 14) → `Store.create(config.databaseUrl)`.
- [ ] **Step 6:** `bun typecheck && bun test` — green.
- [ ] **Step 7: Commit**

```bash
git add hub/src/configuration.ts hub/src/startHub.ts
git commit -m "feat(hub): require DATABASE_URL, remove DB_PATH (P4 config switch)"
```

---

### Task 16: Delete old SQLite store + legacy migrator + v8/v9 tests

**Files:**
- Delete: `hub/src/store/sessions.ts`, `messages.ts`, `machines.ts`, `users.ts`, `pushSubscriptions.ts`, `versionedUpdates.ts`, `sessionStore.ts`, `messageStore.ts`, `machineStore.ts`, `userStore.ts`, `pushStore.ts`
- Delete: `hub/src/store/migration-v8.test.ts`, `hub/src/store/migration-v9.test.ts`, `hub/src/store/sessions.test.ts`, `hub/src/store/messages.test.ts` (old, superseded by `pg/*.test.ts`)
- Delete: `hub/src/cursor/cursorLegacyMigrator.ts`, `hub/src/cursor/fixtures/buildSyntheticLegacyStore.ts`
- Modify: `hub/scripts/cleanup-sessions.ts` (port from SQLite to PG)
- Verify: no `bun:sqlite` import remains under `hub/src/` (runtime).

- [ ] **Step 1: Remove `cursorLegacyMigrator` usage from its sole importer FIRST**

`hub/src/sync/syncEngine.ts:19` imports `CursorLegacyMigrator` and uses it at runtime. Before deleting the migrator, remove the import + all usage sites in `syncEngine.ts` (the legacy pre-V8 SQLite migration path is obsolete — fresh PG has no legacy SQLite to migrate from; existing users run the P5 script instead). Verify with `grep -rn cursorLegacyMigrator hub/src` → only the migrator file + its fixture remain.

- [ ] **Step 2: Confirm nothing under `hub/src/store/pg/` or consumers imports the old modules**

```bash
cd hub && grep -rn "from '\.\./store/\(sessions\|messages\|machines\|users\|pushSubscriptions\|versionedUpdates\)'" src --include="*.ts" | grep -v "/pg/"
```

Expected: empty.

- [ ] **Step 3: Delete the files**

```bash
cd hub && git rm \
  src/store/sessions.ts src/store/messages.ts src/store/machines.ts \
  src/store/users.ts src/store/pushSubscriptions.ts src/store/versionedUpdates.ts \
  src/store/sessionStore.ts src/store/messageStore.ts src/store/machineStore.ts \
  src/store/userStore.ts src/store/pushStore.ts \
  src/store/migration-v8.test.ts src/store/migration-v9.test.ts \
  src/store/sessions.test.ts src/store/messages.test.ts \
  src/cursor/cursorLegacyMigrator.ts src/cursor/fixtures/buildSyntheticLegacyStore.ts
```

(Adjust if `namespace.test.ts` or other old tests still fail — delete only tests of the removed SQLite store, not PG tests.)

- [ ] **Step 4: Verify no runtime `bun:sqlite` import remains**

```bash
cd hub && grep -rn "bun:sqlite" src --include="*.ts"
```

Expected: empty (after Step 5). `hub/scripts/*` may still use it — those are addressed next.

- [ ] **Step 5: Port `hub/scripts/cleanup-sessions.ts` to PG** — it currently opens SQLite directly. Replace with `const store = await Store.create(process.env.DATABASE_URL!)`, use the async session API for the cleanup pass, `await store.close()`.
- [ ] **Step 6:** `bun typecheck && bun test` — green.
- [ ] **Step 7: Commit**

```bash
git add -A hub/src hub/scripts
git commit -m "chore(hub): delete SQLite store, v8/v9 migration tests, cursorLegacyMigrator (P4 cleanup)"
```

---

## Phase P5 — Migration script + docs

### Task 17: `sqlite→postgres` migration script

**Files:**
- Create: `hub/scripts/migrate-sqlite-to-postgres.ts`
- Create: `hub/scripts/migrate-sqlite-to-postgres.test.ts`

**Interfaces:**
- Produces: a standalone CLI `bun run hub/scripts/migrate-sqlite-to-postgres.ts --sqlite <path> --to <DATABASE_URL> [--dry-run] [--force]` that copies all 5 tables from a V10 SQLite file into the target PG DB.

- [ ] **Step 1: Write the script**

```ts
import { Database } from 'bun:sqlite' // read-only source side
import postgres from 'postgres'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { values } = parseArgs({
    options: {
        sqlite: { type: 'string' },
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
    },
})

const srcPath = values.sqlite
const dstUrl = values.to
if (!srcPath || !dstUrl) {
    console.error('usage: migrate-sqlite-to-postgres --sqlite <path> --to <DATABASE_URL> [--dry-run] [--force]')
    process.exit(2)
}

const dryRun = values['dry-run'] === true && values.force !== true

const src = new Database(srcPath, { readonly: true, strict: true })
const versionRow = src.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
const srcVersion = versionRow?.user_version ?? 0
if (srcVersion !== 10) {
    console.error(`Source SQLite user_version is ${srcVersion}, expected 10. ` +
        'Run your current hub once to auto-upgrade, then retry.')
    process.exit(1)
}

const sql = postgres(dstUrl, { types: { bigint: postgres.toNumber } })

// ensure target schema exists (inline schema.sql so the script is self-contained)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ddl = readFileSync(resolve(__dirname, '../src/store/schema.sql'), 'utf8')
await sql.begin(async (tx) => {
    await tx.unsafe(ddl)
    await tx`INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING`
})

if (!values.force) {
    const [{ populated }] = await sql`SELECT EXISTS(SELECT 1 FROM sessions LIMIT 1) AS populated`
    if (populated) {
        console.error('Target already has data. Re-run with --force to truncate first.')
        await sql.end(); src.close(); process.exit(1)
    }
} else {
    await sql`TRUNCATE messages, sessions, machines, users, push_subscriptions RESTART IDENTITY CASCADE`
}

const TABLES = ['users', 'push_subscriptions', 'machines', 'sessions', 'messages'] as const
const COLUMNS: Record<typeof TABLES[number], readonly string[]> = {
    users: ['id', 'platform', 'platform_user_id', 'namespace', 'created_at'],
    push_subscriptions: ['id', 'namespace', 'endpoint', 'p256dh', 'auth', 'created_at'],
    machines: ['id', 'namespace', 'created_at', 'updated_at', 'metadata', 'metadata_version', 'runner_state', 'runner_state_version', 'active', 'active_at', 'seq'],
    sessions: ['id', 'tag', 'namespace', 'machine_id', 'created_at', 'updated_at', 'metadata', 'metadata_version', 'agent_state', 'agent_state_version', 'model', 'model_reasoning_effort', 'effort', 'service_tier', 'todos', 'todos_updated_at', 'team_state', 'team_state_updated_at', 'active', 'active_at', 'seq'],
    messages: ['id', 'session_id', 'content', 'created_at', 'seq', 'local_id', 'invoked_at', 'scheduled_at'],
}

const plan: string[] = []
for (const table of TABLES) {
    const { count } = src.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    plan.push(`${table}: ${count} rows`)
}
console.log('Migration plan:\n  ' + plan.join('\n  '))
if (dryRun) {
    console.log('\n--dry-run: no data written. Re-run with --force to apply.')
    await sql.end(); src.close(); process.exit(0)
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

// reset SERIAL sequences
await sql`SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 0) FROM users))`
await sql`SELECT setval('push_subscriptions_id_seq', (SELECT COALESCE(MAX(id), 0) FROM push_subscriptions))`

// verify counts
let mismatch = false
for (const table of TABLES) {
    const sCount = (src.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    const [{ dcount }] = await sql`SELECT COUNT(*)::int AS dcount FROM ${sql.unsafe(table)}`
    const ok = sCount === dcount
    console.log(`verify ${table}: src=${sCount} dst=${dcount} ${ok ? 'OK' : 'MISMATCH'}`)
    if (!ok) mismatch = true
}
if (mismatch) {
    console.error('Count mismatch — inspect target and re-run with --force after fixing.')
    await sql.end(); src.close(); process.exit(1)
}

await sql.end()
src.close()
console.log('Migration complete.')
```

- [ ] **Step 2: Write a self-test** (`hub/scripts/migrate-sqlite-to-postgres.test.ts`) — build a small V10-shape `:memory:` SQLite DB with `bun:sqlite` directly, insert sample rows (synthetic values, e.g. `id: 'sess-test'`, `created_at: 1700000000000`), run the migrator into the test PG DB, assert target row counts match and a sample row's `created_at` round-trips as a `number`. Gate with `itPg`.
- [ ] **Step 3: Run**

```bash
cd hub && bun test scripts/migrate-sqlite-to-postgres.test.ts
```

Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add hub/scripts/migrate-sqlite-to-postgres.ts hub/scripts/migrate-sqlite-to-postgres.test.ts
git commit -m "feat(hub): sqlite→postgres one-time migration script (V10 source, setval, verify)"
```

---

### Task 18: Docs + Docker updates

**Files:**
- Modify: `README.md`, `docs/guide/installation.md`, `docs/guide/how-it-works.md` (any DB mention), `hub/README.md`
- Modify: `Dockerfile` / root `docker-compose.yml` (hub image): document/add the Postgres dependency

- [ ] **Step 1:** In `README.md` "Getting Started", replace the one-line `npx @twsxtd/hapi hub --relay` block with two steps: (1) have a Postgres reachable and `export DATABASE_URL=…`, (2) run the hub. Link the migration script for existing users.
- [ ] **Step 2:** In `docs/guide/installation.md`, add a "Database (PostgreSQL)" section: required `DATABASE_URL`, optional `DATABASE_SSL`/`DATABASE_MAX_CONNECTIONS`, a `docker run postgres:16` snippet, and the `migrate-sqlite-to-postgres` upgrade path with the `--dry-run` / `--force` flow.
- [ ] **Step 3:** Update the hub `Dockerfile`/compose so the image notes `DATABASE_URL` is required; if there's a compose example, add a `postgres:16` service + `DATABASE_URL` env wired to it.
- [ ] **Step 4:** `hub/README.md` — note PG requirement.
- [ ] **Step 5: Commit**

```bash
git add README.md docs/ Dockerfile docker-compose*.yml hub/README.md
git commit -m "docs(hub): PostgreSQL requirement, DATABASE_URL, migration instructions (P5)"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- §1 decision (full replace, runner untouched) → Tasks 10/16 (flip+delete); `cli` untouched (Global Constraints).
- §2 async strategy + socket try/catch → Task 13 (pattern block), Tasks 11/12 (layers).
- §3 schema + `schema_migrations` + `cursorLegacyMigrator` deletion → Task 3 (schema), Task 16 (delete migrator).
- §4 driver/config/BIGINT/factory/lifecycle → Task 1 (dep), Task 3 (factory+BIGINT), Task 15 (DATABASE_URL), Task 14 (close).
- §5 migration script (V10 guard, setval, verify, dry-run/force) → Task 17.
- §6 error handling (transactions, version mismatch) → Port Rules R7/R8 + Tasks 5–9. *(Note: `addMessage`'s localId dedup is SELECT-then-INSERT, not a constraint catch — preserved by the port, so no `23505` mapping task is needed.)*
- §7 test strategy (real PG + TRUNCATE + skip guard + delete v8/v9) → Tasks 2/4 (infra+helper), Task 16 (delete v8/v9).
- §8 phasing P1–P5 → tasks grouped by phase.
- §9 scope-outs → none implemented (confirmed).

**2. Placeholder scan:** Task 17's verify block is concrete (count compare + abort). Task 5 gives an explicit recommendation (drop generic `setClauses`; bespoke UPDATE) with the caller pattern shown in Task 6. No "TBD"/"implement later"/"add error handling" without code.

**3. Type consistency:** `Sql` defined Task 3, used uniformly (Tasks 4–9). `Store.create(connectionString, opts)` stable across Tasks 3/4/14/15. `createTestStore()` stable (Tasks 4–9). `updateVersionedField` args shape stable (Tasks 5–7). Barrel exports (Task 10) match existing consumer imports (`Store`, `SessionStore`, types).
