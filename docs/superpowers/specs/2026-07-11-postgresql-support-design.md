# HAPI PostgreSQL 支持设计

- **日期**:2026-07-11
- **状态**:已通过 brainstorming,待实现规划
- **范围**:把 `hub` 包的数据存储从 SQLite 完全替换为 PostgreSQL

## 1. 背景与决策

HAPI 是 local-first 的多 agent 会话控制工具(Claude Code / Codex / Gemini / OpenCode),monorepo 含 `cli`/`shared`/`hub`/`web`/`website`/`docs`。当前数据存储只在 `hub` 包,使用 `bun:sqlite`,原生 SQL,**无 ORM**,5 张表(`sessions`/`machines`/`messages`/`users`/`push_subscriptions`),schema version 10,基于 `PRAGMA user_version` 的阶梯迁移系统,WAL 模式。

### 关键决策(brainstorming 阶段已确认)

1. **范围——完全替换**:hub 中完全用 PostgreSQL 替换 SQLite。已核查 HAPI 自身的 `Store` 类**只在 `hub` 使用**;`cli`(runner)不使用 HAPI 数据库——`cli/src/opencode/utils/opencodeStorageScanner.ts` 里唯一的 `bun:sqlite` 用法是**只读**打开 OpenCode 自己的 `opencode.db`(第三方 app 的库),与本迁移无关,**保持不动**。`shared`/`web` 无数据库使用。
2. **场景——服务器/云端常驻部署**:把 hub 长期跑在 VPS/服务器,用 Postgres(可能托管、带备份)作为生产后端。
3. **数据——提供迁移脚本**:提供一次性 `sqlite→postgres` 迁移脚本,保留现有用户的会话/消息历史。
4. **方案选型——方案 1**:采用 `postgres`(porsager)原始驱动,**保留现有 Store 架构**(Store 类 + 纯函数查询模块),只重写 SQL 方言 + async 化。不引入 ORM/query-builder。

### 无法回避的核心约束

> **`bun:sqlite` 是同步 API,所有 PostgreSQL 驱动都是异步的。**

当前 hub 数据层全同步(`SessionStore.getSession()` 直接返回对象,非 Promise)。换 Postgres 后,`Store` 的所有方法必须变 `async`,所有调用方(17 个生产文件)需 async 传播。这是本次最大工作量,无法绕过(没有可用的同步 Postgres 驱动;不引入阻塞事件循环的 hack)。

## 2. 架构与 async 传播策略

### 现状分层(同步)

```
路由 (Hono) / socket.io handler  ──同步──┐
syncEngine / messageService / rpcGateway    │
sessionCache / machineCache (内存缓存层)    │ 同步
SessionStore / MachineStore / ... (薄封装)  │
sessions.ts / messages.ts / ... (52 纯函数) │
bun:sqlite Database  ◄── 同步 .prepare().get()/.all()
```

### 目标分层(全 async)

```
路由 (Hono, 已多 async) / socket.io handler (改 async, 内部 try/catch)   async
syncEngine / messageService / rpcGateway / bot / pushService              async
sessionCache / machineCache (写穿缓存, async)                             async
SessionStore / MachineStore / ... (薄封装, 方法变 async)                  async
sessions.ts / messages.ts / ... (52 函数, 全 async, porsager 标签模板)    async
postgres(DATABASE_URL)  ◄── pooled, await sql`...`
```

### 传播原则:自底向上,保持现有边界,不改业务逻辑

| 层 | 文件 | 改动 |
|---|---|---|
| **L0 查询纯函数** | `sessions.ts`/`messages.ts`/`machines.ts`/`users.ts`/`pushSubscriptions.ts`/`versionedUpdates.ts`(52 函数) | `fn(db, ...)` → `async fn(sql, ...)`,返回 `Promise`;SQL 改 PG 方言。机械、可逐函数 TDD。 |
| **L1 Store 类** | `SessionStore` 等 5 个 | 方法加 `async`/`await` 转发,纯透传。 |
| **L2 缓存层** | `sessionCache.ts`(52KB)/`machineCache.ts`(8KB) | 写穿缓存;读路径变 `async get()`,未命中 `await store.x()` 回填。 |
| **L3 业务编排** | `syncEngine.ts`(72KB)/`messageService.ts`(28KB)/`rpcGateway.ts` | 内部调用加 `await`。改动量集中区,但**不改业务逻辑**,只改调用形式。 |
| **L4 入口** | Hono 路由(多已 async)、socket.io handler、telegram bot | 路由补 `await`;socket handler `socket.on('evt', async (data) => { try {...} catch (e) { socket.emit('error', ...) } })`——**必须包 try/catch**(socket.io 忽略返回 promise,未捕获 rejection 不冒泡);grammy 天然 async。 |

### 明确不做

- 不引入"同步阻塞读 PG"的 hack(阻塞事件循环,违背 Node/Bun 模型)。
- 不改变缓存语义(write-through 不变)、业务逻辑不变——L0–L3 仅改调用形式,仅 L4 socket handler 加 try/catch 这一"加逻辑"点。

## 3. Postgres Schema 与迁移系统

### 方言翻译

| SQLite 现状 | 问题 | Postgres 处理 | 性质 |
|---|---|---|---|
| `created_at`/`updated_at`/`active_at`/`seq`/各 `*_version` 等 `INTEGER` | ⚠️ PG `INTEGER` 是 32 位(epoch ms 在 2038 溢出);SQLite `INTEGER` 是 64 位 | 全部改 **`BIGINT`** | **必须(正确性)** |
| `id INTEGER PRIMARY KEY AUTOINCREMENT`(users/push_subscriptions) | PG 无 `AUTOINCREMENT` | 改 **`SERIAL PRIMARY KEY`** | **必须** |
| `active INTEGER DEFAULT 0` | PG 有真 `BOOLEAN` | **保留 `INTEGER DEFAULT 0`** | 最小改动(避免 app 层 `0/1↔bool` 转换) |
| `metadata`/`agent_state`/`todos` 等 `TEXT`(存 JSON 串) | PG 有 `JSONB` | **保留 `TEXT`** | 最小改动(app 仍 `JSON.stringify/parse`) |
| 部分索引 `WHERE local_id IS NOT NULL`、表达式索引 `COALESCE(...)` | PG 原生支持 | 语法不变 | 兼容 |
| `FOREIGN KEY ... ON DELETE CASCADE` | PG 默认开 FK | 语法不变,去掉 `PRAGMA foreign_keys=ON` | 兼容 |
| `PRAGMA journal_mode=WAL`/`busy_timeout`/`synchronous` | PG 无对应概念 | 删除,由服务端/连接池处理 | 删除 |

> **BIGINT 是硬性正确性要求**。`active_at`/`seq`/各时间戳若误用 `INTEGER`(32 位)会在 2038 甚至更早溢出(SQLite `INTEGER` 是 64 位)。逐列核对。

### 目标 Schema(等价于当前 V10 形态)

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tag TEXT,
    namespace TEXT NOT NULL DEFAULT 'default',
    machine_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata TEXT,
    metadata_version BIGINT DEFAULT 1,
    agent_state TEXT,
    agent_state_version BIGINT DEFAULT 1,
    model TEXT,
    model_reasoning_effort TEXT,
    effort TEXT,
    service_tier TEXT,
    todos TEXT,
    todos_updated_at BIGINT,
    team_state TEXT,
    team_state_updated_at BIGINT,
    active INTEGER DEFAULT 0,
    active_at BIGINT,
    seq BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata TEXT,
    metadata_version BIGINT DEFAULT 1,
    runner_state TEXT,
    runner_state_version BIGINT DEFAULT 1,
    active INTEGER DEFAULT 0,
    active_at BIGINT,
    seq BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    local_id TEXT,
    invoked_at BIGINT,
    scheduled_at BIGINT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_position
    ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
    ON messages(scheduled_at)
    WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at BIGINT NOT NULL,
    UNIQUE(platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    namespace TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE(namespace, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
```

### 迁移系统

- 用 `schema_migrations` 表替代 `PRAGMA user_version`:
  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- **全新 Postgres 库**:直接跑 `createSchema()`(上面的最终形态)+ 插入 `version = 1`。**不重放** SQLite 的 V1→V10 阶梯——那段(daemon→runner 重命名列、逐步 ALTER 加列)只对"升级旧 SQLite 文件"有意义;Postgres 是全新起点。
- **未来 PG 内部演进**:编号迁移(`migrate_0002_xxx.sql` …)逐个 apply + 记录 version,沿用现有"每步幂等 + 列存在性守卫"范式。porsager 可 `await sql.file(...)` 执行。
- 删除 `getUserVersion()`/`setUserVersion()`/`PRAGMA user_version`,改读 `schema_migrations`。

### `cursorLegacyMigrator.ts` 处置

它是从 HAPI **远古 SQLite schema**(pre-V8)归一化的逻辑(72KB)。hub 移除 SQLite 后:
- 从 hub 运行时**移除**;
- "读旧格式"逻辑**不并入**迁移脚本——脚本要求源已是 V10(见 §5),古老文件先经现版 hub 归一化。该文件**整体删除**。

## 4. 驱动、配置与连接管理

### 依赖

- **新增**:`hub` 依赖 `postgres`(porsager)
- **移除**:hub 运行时不再 `import 'bun:sqlite'`
- **保留为脚本依赖**:`bun:sqlite` 仍用于 §5 迁移脚本(只读源),属工具链而非运行时

### 配置:`DB_PATH` → `DATABASE_URL`

`hub/src/configuration.ts` 中 `DB_PATH`(env-only)替换为 `DATABASE_URL`:

```ts
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)')
}
```

- **`DATABASE_URL` 必填**,缺则 fail-fast 并给清晰报错。"完全替换"的必然代价:`npx hapi hub` 的零依赖开体验需要先有 Postgres。
- 可选 env:`DATABASE_SSL`(`require`/`prefer`/`disable`,默认对非 localhost `require`,适配 Supabase/RDS)、`DATABASE_MAX_CONNECTIONS`(默认 10)。

### Store 构造与 `sql` 句柄

```ts
import postgres from 'postgres'

export interface StoreOptions {
    max?: number
    ssl?: 'require' | 'prefer' | 'disable'
    sql?: Sql                  // 可选:注入已存在的连接池(测试复用单例池用)
}

export class Store {
    private readonly sql: Sql
    readonly sessions: SessionStore
    private readonly ownsSql: boolean   // 注入的 sql 在 close() 时不 end()(由所有者管)
    // ...
    private constructor(sql: Sql, ownsSql: boolean) { this.sql = sql; this.ownsSql = ownsSql }
    static async create(connectionString: string, opts: StoreOptions = {}): Promise<Store> {
        let sql: Sql
        let ownsSql: boolean
        if (opts.sql) {
            sql = opts.sql          // 测试:复用模块级单例池,不持有所有权
            ownsSql = false
        } else {
            sql = postgres(connectionString, {
                max: opts?.max ?? 10,
                ssl: opts?.ssl ?? defaultSsl(connectionString),
                types: { bigint: postgres.toNumber },   // ⚠️ 关键
            })
            ownsSql = true
        }
        const store = new Store(sql, ownsSql)
        await store.initSchema()
        store.sessions = new SessionStore(store.sql)   // 各 Store 类接收 sql
        // ...
        return store
    }
    async close() { if (this.ownsSql) await this.sql.end({ timeout: 5 }) }
}
```

### ⚠️ 关键正确性:BIGINT 类型解析

Postgres 驱动(`pg`/porsager)**默认把 `int8`/`BIGINT` 解析为字符串**防精度丢失。`created_at`(epoch ms ~`1.7e12`)、`seq`、SERIAL `id` 等都在 `Number.MAX_SAFE_INTEGER`(`9e15`)内,必须配置:

```ts
types: { bigint: postgres.toNumber }
```

否则 `created_at` 返回 `"1700000000000"`(字符串),所有数值比较/算术/`seq` 自增静默崩溃。与 SQLite(整数即 number)最大的行为差异。全局配置并写一条测试守住(断言读回的 `created_at` 是 `number`)。

### 构造 async 化:factory 模式

当前 `new Store(path)` 同步构造(内部跑 schema)。Postgres 的 `initSchema()` 是 async。采用 **`Store.create()` async factory**(`startHub.ts:167` 改 `await Store.create(config.databaseUrl)`),而非"构造同步、schema 延迟到首查"(冷启动延迟 + 错误时机差)。

### 连接生命周期

- `close()` 同步 → **async**(`await sql.end()`)。调用方(`startHub` 关停、`hub/scripts/cleanup-sessions.ts`)补 `await`。
- 移除 `dbPath` getter、WAL/SHM 文件 `chmod`、`Bun.gc(true)` 等 SQLite 专属逻辑。

## 5. sqlite→postgres 迁移脚本

### 定位

一次性离线工具,用户停掉 hub 后手动运行,把现有 SQLite 数据导入 Postgres。

- **新文件**:`hub/scripts/migrate-sqlite-to-postgres.ts`
- **读源**:`bun:sqlite`(只读);**写目标**:`postgres`
- **前置守卫**:检查源 `PRAGMA user_version`,**要求 = 10**;若 < 10,拒绝并提示"请先用当前版本 hub 启动一次(自动升级到 V10)再运行本脚本"。脚本**只处理 V10 形态**。

### 复制顺序与关键点

1. **按依赖序插入(主)**:users / push_subscriptions → machines → sessions → messages。正确顺序下 FK 约束自然满足,无需禁用。
2. **关 FK(可选)**:仅在需要乱序批量导入时考虑 `SET session_replication_role = 'replica'`(或逐表 `DISABLE TRIGGER ALL`),复制后恢复。⚠️ 托管 PG(Supabase/RDS)迁移用户可能无此权限,故**默认依赖上面的顺序保证,不禁用 FK**。
3. **保留显式主键**:所有 `id`/`created_at`/`seq` 原样写入,历史时间线不变。
4. **⚠️ 重置 SERIAL 序列**:users/push_subscriptions 用 `SERIAL`,批量插入显式 `id` 后序列停在 1,下次自增撞主键。复制完必须:
   ```sql
   SELECT setval('users_id_seq',            (SELECT COALESCE(MAX(id),0) FROM users));
   SELECT setval('push_subscriptions_id_seq',(SELECT COALESCE(MAX(id),0) FROM push_subscriptions));
   ```
5. **批量**:porsager `sql\`INSERT INTO ... VALUES ${sql(rows.map(...))}\`` 分批(每批 ~1000 行)。
6. **校验**:逐表 `SELECT count(*)` 源/目标比对,不等则中止并回滚。
7. **幂等/安全**:`--dry-run`(默认,只打印计划);`--force` 才真写;目标库已有数据时拒绝(除非 `--force`)。

### 使用

```bash
# 1. 停 hub
# 2. (若源库 < V10)先用现版 hub 启动一次,自动升级
# 3. 干跑
bun run hub/scripts/migrate-sqlite-to-postgres.ts \
    --sqlite ~/path/to/hapi.db \
    --to "$DATABASE_URL" --dry-run
# 4. 真跑
bun run hub/scripts/migrate-sqlite-to-postgres.ts \
    --sqlite ~/path/to/hapi.db \
    --to "$DATABASE_URL" --force
```

## 6. 错误处理

- **PG 错误映射**:porsager 抛 `PostgresError`(`.code`/`.constraint_name`)。现有唯一约束冲突(`UNIQUE(session_id, local_id)` 去重、`UNIQUE(platform, platform_user_id)`)改为按 `.code === '23505'`(unique_violation)识别,保持现有去重语义。
- **连接失败**:`Store.create()` 阶段 fail-fast,清晰报错(含 host,提示 SSL/网络)。
- **版本不匹配**:`buildSchemaMismatchError()`(SQLite)→ 查 `schema_migrations`,版本不支持时报"期望 vN,发现 vM,请升级 hub"。
- **事务原子性**:`versionedUpdates.ts` 等多步写,用 `await sql.begin(async tx => {...})` 包裹,替代 SQLite 隐式行为。
- **`schema_migrations` 应用**:`Store.create()` 启动时跑迁移,迁移在单事务内 + 写 version,失败整体回滚。

## 7. 测试策略

### 方案:真实 Postgres + 共享 helper

- **真实 Postgres**(与生产同驱动,能抓 porsager/PG 方言问题),不用模拟。`pglite`(WASM PG)作为**未来可选优化**,本次不引入(走自己 API,绕过 porsager,会掩盖驱动层问题)。
- **新增 `hub/src/store/testStore.ts` helper**:
  ```ts
  // 进程级单例池:schema 仅初始化一次,所有测试复用同一池
  let _sharedSql: Sql | null = null
  async function getSharedSql(): Promise<Sql> {
      if (!_sharedSql) {
          _sharedSql = postgres(process.env.TEST_DATABASE_URL!, { types: { bigint: postgres.toNumber } })
          await initSchema(_sharedSql)   // 仅首次
      }
      return _sharedSql
  }
  export async function createTestStore(): Promise<Store> {
      const sql = await getSharedSql()
      await truncateAll(sql)                  // 每次 createTestStore() 清空所有表
      return await Store.create('', { sql })  // 注入共享池,Store 不持有所有权
  }
  ```
- **隔离**:`CREATE DATABASE` 每 case 太慢(~100ms × 数百 case)。改用**单库 + 每次清空表**(TRUNCATE CASCADE),在 `createTestStore()` 执行,保留现有"每 case 全新状态"语义,成本接近零。
- **本地**:`hub/docker-compose.test.yml` 起 `postgres:16`;`TEST_DATABASE_URL` 指向它。
- **CI**:GitHub Actions `services: postgres:16` service container + healthcheck。更新 workflow。
- **缺失保护**:`TEST_DATABASE_URL` 缺失时 skip 测试(非全部 fail)+ 一次性提示,避免没装 PG 的开发者本地 `bun test` 雪崩。

### 迁移测试

- 现有 `migration-v8.test.ts`(37KB)、`migration-v9.test.ts`(23KB)测 SQLite 阶梯迁移,**删除**。
- 改为测 Postgres 的 `schema_migrations` 应用幂等性、`Store.create()` 在全新库上建正确 schema、断言 BIGINT 列类型正确(守住 §4 bigint 解析)。

## 8. 分阶段落地

Store 一旦 async 化会立刻打破所有消费者,"原处边改边坏"会让分支长期红。采用**并行开发 → 一次切换**,每阶段独立提交、可 review、测试绿:

| 阶段 | 内容 | 生产状态 |
|---|---|---|
| **P1 基建** | 加 `postgres` 依赖、`docker-compose.test.yml`、`createTestStore()` helper、`TEST_DATABASE_URL` 进 CI、`schema_migrations` 框架 | 仍 SQLite,全绿 |
| **P2 查询层移植** | 在 `hub/src/store/pg/`(新)下逐表把 52 函数 + 5 Store 类改成 async+PG 方言,配单元测试(sessions/messages/machines/users/push 各绿) | 旧 SQLite Store 仍服务生产 |
| **P3 消费者 async 化** | 一次性垂直贯通:sessionCache/machineCache → syncEngine/messageService/rpcGateway → 路由(补 await)+ socket handler(async+try/catch)。机械式改调用形式 | 切换点,本地全套测试绿 |
| **P4 切换 + 清理** | `configuration.ts` 用 `DATABASE_URL`、`startHub` 改 `await Store.create()`;**删除**旧 SQLite Store、`migration-v8/v9.test.ts`、`cursorLegacyMigrator.ts`、`DB_PATH`;`bun:sqlite` 退出 hub 运行时 | 生产跑 PG |
| **P5 脚本 + 文档** | 迁移脚本、README/docs/docker(`postgres:16`)、`Dockerfile` PG 依赖说明 | 完成 |

P3 是唯一"大改"提交,但纯机械(await + try/catch),不改业务逻辑。

## 9. 范围之外(YAGNI,明确不做)

- 多实例/读副本/分片(P1 以后再评估)
- `JSONB`/`BOOLEAN` 列类型升级(独立后续项)
- `pglite` 测试加速(若未来测试延迟成问题)
- 在 hub 运行时保留 SQLite(明确完全替换)

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| BIGINT 误用 INTEGER → 时间戳溢出 | §3 逐列核对 + §4 全局 type parser + §7 测试断言类型 |
| BIGINT 默认返回字符串 → 比较崩溃 | `types: { bigint: postgres.toNumber }` + 守护测试 |
| SERIAL 序列未重置 → 迁移后主键冲突 | §5 复制后 `setval` + 迁移脚本自测 |
| socket handler async 未 catch → 静默 rejection | §2 L4 强制 try/catch,代码 review 检查 |
| async 传播面广(17 文件) | §8 P2 先在 `store/pg/` 并行开发,P3 一次垂直贯通,保持主分支每步绿 |
| `:memory:` 测试无法直译 | §7 createTestStore + TRUNCATE-per-case 单例池 |
| 现有用户开体验变化(需 Postgres) | README/docs 更新;迁移脚本降低升级门槛 |

## 11. 变更文件清单(预估)

**新增**:
- `hub/src/store/pg/`(查询函数 + Store 类的 PG 实现,迁移期)
- `hub/src/store/testStore.ts`(测试 helper)
- `hub/src/store/schema/`(PG schema + 编号迁移 SQL)
- `hub/scripts/migrate-sqlite-to-postgres.ts`
- `hub/docker-compose.test.yml`

**重写(async + PG 方言)**:`hub/src/store/{sessions,messages,machines,users,pushSubscriptions,versionedUpdates,sessionStore,messageStore,machineStore,userStore,pushStore,index}.ts`,L2–L4 的 17 个消费者文件。

**删除**:`hub/src/store/migration-v8.test.ts`、`migration-v9.test.ts`、`hub/src/cursor/cursorLegacyMigrator.ts` 及其 fixtures、`DB_PATH` 配置。

**配置**:`hub/package.json`(加 `postgres`)、`hub/src/configuration.ts`(`DATABASE_URL`)、CI workflow、`Dockerfile`、README/docs。
