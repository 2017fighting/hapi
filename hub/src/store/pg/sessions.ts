import { randomUUID } from 'node:crypto'

import type { Sql } from '../pgIndex'
import type { StoredSession, VersionedUpdateResult } from '../types'
import { safeJsonParse } from '../json'

// Carry-forward fields that the hub preserves across any metadata
// replacement when the incoming write omits them.
//
// The CLI's archive transition (cli/src/agent/runnerLifecycle.ts
// archiveAndClose) spreads `currentMetadata` from the session client's
// local cache; if that cache is `null` (e.g. the row's metadata failed
// Zod parse at bootstrap and got nulled out in cli/src/api/api.ts) or
// stale, the resulting payload is sparse and the unconditional REPLACE
// in updateSessionMetadata wipes whatever it omits. That breaks resume
// even though the on-disk chat data still exists.
//
// Three preservation tiers cover the failure modes:
//
//   - PARSE_IDENTITY_FIELDS: required by MetadataSchema in
//     shared/src/schemas.ts. Without these, hub session cache and CLI
//     getSession reject the row with safeParse → metadata becomes null
//     downstream and resume cannot find a path even when the resume
//     token survived.
//
//   - ROUTING_FIELDS: flavor + machineId. `flavor` is what
//     hub/src/web/routes/sessions.ts and hub/src/sync/syncEngine.ts use
//     to pick which session id field to read; if it's dropped, the
//     `?? 'claude'` fallback misroutes a Cursor/Codex/Gemini session as
//     Claude and the preserved token is ignored. `machineId` is the
//     filter the CLI's resumable listing uses to scope rows to the
//     current host; without it the row drops out of the resume picker.
//
//   - SIMPLE_RESUME_TOKENS: flavor-specific resume identifiers that are
//     write-once-keep semantics. Mirror of pickExistingSessionMetadata
//     in cli/src/agent/sessionFactory.ts.
//
// `cursorSessionProtocol` is paired with `cursorSessionId`: protocol is
// tied to a specific chat id, so a write that explicitly sets a new
// `cursorSessionId` must drop a stale prior protocol. Handled in
// preserveCursorProtocolPair below.
//
// Explicit-clear sentinel: when `next` sets a carry-forward field to
// `null`, the merge drops the key entirely from the output (the
// resulting blob has neither the prior value nor `null`). This lets
// callers intentionally remove a preserved field — e.g.
// `cli/src/codex/session.ts` `resetCodexThread()` clears the codex
// thread id with `codexSessionId: null` so a `/clear` command actually
// drops the persisted thread. `undefined` (key missing from `next`)
// continues to mean "carry forward".
const PARSE_IDENTITY_FIELDS = ['path', 'host'] as const

const ROUTING_FIELDS = ['flavor', 'machineId'] as const

const SIMPLE_RESUME_TOKENS = [
    'claudeSessionId',
    'codexSessionId',
    'geminiSessionId',
    'opencodeSessionId',
    'cursorSessionId',
    'kimiSessionId'
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function carryForwardIfMissing(
    prior: Record<string, unknown>,
    next: Record<string, unknown>,
    merged: Record<string, unknown> | null,
    fields: ReadonlyArray<string>
): Record<string, unknown> | null {
    let result = merged
    for (const field of fields) {
        // Explicit-clear sentinel: `null` in next means "drop this field".
        // Strip it from the merged output so the persisted blob stays
        // schema-clean (MetadataSchema fields are `string().optional()`
        // — string|undefined, not nullable).
        if (next[field] === null) {
            if (result === null) {
                result = { ...next }
            }
            delete result[field]
            continue
        }
        if (next[field] === undefined && prior[field] !== undefined) {
            if (result === null) {
                result = { ...next }
            }
            result[field] = prior[field]
        }
    }
    return result
}

function preserveCursorProtocolPair(
    prior: Record<string, unknown>,
    next: Record<string, unknown>,
    merged: Record<string, unknown> | null
): Record<string, unknown> | null {
    // If next explicitly sets cursorSessionId, the protocol is tied to
    // the new id — never carry over the prior protocol. The next write
    // can include its own cursorSessionProtocol if it knows the protocol.
    if (next.cursorSessionId !== undefined) {
        return merged
    }
    // Otherwise next is silent on the id (and possibly the protocol);
    // carry over the prior protocol so it stays paired with the prior id
    // (which is preserved via SIMPLE_RESUME_TOKENS above).
    if (next.cursorSessionProtocol === undefined && prior.cursorSessionProtocol !== undefined) {
        const result = merged ?? { ...next }
        result.cursorSessionProtocol = prior.cursorSessionProtocol
        return result
    }
    return merged
}

export function mergeSessionMetadata(prior: unknown, next: unknown): unknown {
    if (!isPlainObject(prior) || !isPlainObject(next)) {
        return next
    }
    let merged: Record<string, unknown> | null = null
    merged = carryForwardIfMissing(prior, next, merged, PARSE_IDENTITY_FIELDS)
    merged = carryForwardIfMissing(prior, next, merged, ROUTING_FIELDS)
    merged = carryForwardIfMissing(prior, next, merged, SIMPLE_RESUME_TOKENS)
    merged = preserveCursorProtocolPair(prior, next, merged)
    return merged ?? next
}

type DbSessionRow = {
    id: string
    tag: string | null
    namespace: string
    machine_id: string | null
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    agent_state: string | null
    agent_state_version: number
    model: string | null
    model_reasoning_effort: string | null
    effort: string | null
    service_tier: string | null
    todos: string | null
    todos_updated_at: number | null
    team_state: string | null
    team_state_updated_at: number | null
    active: number
    active_at: number | null
    seq: number
}

function toStoredSession(row: DbSessionRow): StoredSession {
    return {
        id: row.id,
        tag: row.tag,
        namespace: row.namespace,
        machineId: row.machine_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        agentState: safeJsonParse(row.agent_state),
        agentStateVersion: row.agent_state_version,
        model: row.model,
        modelReasoningEffort: row.model_reasoning_effort,
        effort: row.effort,
        serviceTier: row.service_tier,
        todos: safeJsonParse(row.todos),
        todosUpdatedAt: row.todos_updated_at,
        teamState: safeJsonParse(row.team_state),
        teamStateUpdatedAt: row.team_state_updated_at,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

export async function getOrCreateSession(
    sql: Sql,
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string,
    model?: string,
    effort?: string,
    modelReasoningEffort?: string
): Promise<StoredSession> {
    const rows = await sql`SELECT * FROM sessions WHERE tag = ${tag} AND namespace = ${namespace} ORDER BY created_at DESC LIMIT 1`
    const existing = rows[0] as DbSessionRow | undefined

    if (existing) {
        return toStoredSession(existing)
    }

    const now = Date.now()
    const id = randomUUID()

    const metadataJson = JSON.stringify(metadata)
    const agentStateJson = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)

    await sql`
        INSERT INTO sessions (
            id, tag, namespace, machine_id, created_at, updated_at,
            metadata, metadata_version,
            agent_state, agent_state_version,
            model,
            model_reasoning_effort,
            effort,
            todos, todos_updated_at,
            active, active_at, seq
        ) VALUES (
            ${id}, ${tag}, ${namespace}, NULL, ${now}, ${now},
            ${metadataJson}, 1,
            ${agentStateJson}, 1,
            ${model ?? null},
            ${modelReasoningEffort ?? null},
            ${effort ?? null},
            NULL, NULL,
            0, NULL, 0
        )
    `

    const row = await getSession(sql, id)
    if (!row) {
        throw new Error('Failed to create session')
    }
    return row
}

export async function updateSessionMetadata(
    sql: Sql,
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): Promise<VersionedUpdateResult<unknown | null>> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt !== false

    try {
        return await sql.begin(async (tx) => {
            const priorRows = await tx`SELECT metadata FROM sessions WHERE id = ${id} AND namespace = ${namespace}`
            const priorRow = priorRows[0] as { metadata: string | null } | undefined

            const prior = priorRow ? safeJsonParse(priorRow.metadata) : null
            const merged = mergeSessionMetadata(prior, metadata)
            const mergedJson = JSON.stringify(merged)

            const result = await tx`
                UPDATE sessions
                SET metadata = ${mergedJson},
                    metadata_version = metadata_version + 1,
                    updated_at = CASE WHEN ${touchUpdatedAt} THEN ${now} ELSE updated_at END,
                    seq = seq + 1
                WHERE id = ${id}
                  AND namespace = ${namespace}
                  AND metadata_version = ${expectedVersion}
            `
            if (result.count === 1) {
                return { result: 'success' as const, version: expectedVersion + 1, value: merged }
            }

            const currentRows = await tx`
                SELECT metadata, metadata_version
                FROM sessions
                WHERE id = ${id} AND namespace = ${namespace}
            `
            const current = currentRows[0] as { metadata: string | null; metadata_version: number } | undefined
            if (!current) {
                return { result: 'error' as const }
            }
            return {
                result: 'version-mismatch' as const,
                version: current.metadata_version,
                value: safeJsonParse(current.metadata)
            }
        })
    } catch {
        return { result: 'error' }
    }
}

export async function updateSessionAgentState(
    sql: Sql,
    id: string,
    agentState: unknown,
    expectedVersion: number,
    namespace: string
): Promise<VersionedUpdateResult<unknown | null>> {
    const now = Date.now()
    const normalized = agentState ?? null

    try {
        const encoded = normalized === null ? null : JSON.stringify(normalized)
        const result = await sql`
            UPDATE sessions
            SET agent_state = ${encoded},
                agent_state_version = agent_state_version + 1,
                updated_at = ${now},
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND agent_state_version = ${expectedVersion}
        `
        if (result.count === 1) {
            return { result: 'success', version: expectedVersion + 1, value: normalized }
        }

        const currentRows = await sql`
            SELECT agent_state, agent_state_version
            FROM sessions
            WHERE id = ${id} AND namespace = ${namespace}
        `
        const current = currentRows[0] as { agent_state: string | null; agent_state_version: number } | undefined
        if (!current) {
            return { result: 'error' }
        }
        return {
            result: 'version-mismatch',
            version: current.agent_state_version,
            value: safeJsonParse(current.agent_state)
        }
    } catch {
        return { result: 'error' }
    }
}

export async function setSessionTodos(
    sql: Sql,
    id: string,
    todos: unknown,
    todosUpdatedAt: number,
    namespace: string
): Promise<boolean> {
    try {
        const json = todos === null || todos === undefined ? null : JSON.stringify(todos)
        const result = await sql`
            UPDATE sessions
            SET todos = ${json},
                todos_updated_at = ${todosUpdatedAt},
                updated_at = CASE WHEN updated_at > ${todosUpdatedAt} THEN updated_at ELSE ${todosUpdatedAt} END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND (todos_updated_at IS NULL OR todos_updated_at < ${todosUpdatedAt})
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function setSessionTeamState(
    sql: Sql,
    id: string,
    teamState: unknown,
    updatedAt: number,
    namespace: string
): Promise<boolean> {
    try {
        const json = teamState === null || teamState === undefined ? null : JSON.stringify(teamState)
        const result = await sql`
            UPDATE sessions
            SET team_state = ${json},
                team_state_updated_at = ${updatedAt},
                updated_at = CASE WHEN updated_at > ${updatedAt} THEN updated_at ELSE ${updatedAt} END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND (team_state_updated_at IS NULL OR team_state_updated_at < ${updatedAt})
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function setSessionModel(
    sql: Sql,
    id: string,
    model: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): Promise<boolean> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = await sql`
            UPDATE sessions
            SET model = ${model},
                updated_at = CASE WHEN ${touchUpdatedAt} THEN ${now} ELSE updated_at END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND model IS DISTINCT FROM ${model}
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function setSessionModelReasoningEffort(
    sql: Sql,
    id: string,
    modelReasoningEffort: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): Promise<boolean> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = await sql`
            UPDATE sessions
            SET model_reasoning_effort = ${modelReasoningEffort},
                updated_at = CASE WHEN ${touchUpdatedAt} THEN ${now} ELSE updated_at END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND model_reasoning_effort IS DISTINCT FROM ${modelReasoningEffort}
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function setSessionServiceTier(
    sql: Sql,
    id: string,
    serviceTier: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): Promise<boolean> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = await sql`
            UPDATE sessions
            SET service_tier = ${serviceTier},
                updated_at = CASE WHEN ${touchUpdatedAt} THEN ${now} ELSE updated_at END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND service_tier IS DISTINCT FROM ${serviceTier}
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function setSessionEffort(
    sql: Sql,
    id: string,
    effort: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): Promise<boolean> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = await sql`
            UPDATE sessions
            SET effort = ${effort},
                updated_at = CASE WHEN ${touchUpdatedAt} THEN ${now} ELSE updated_at END,
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND effort IS DISTINCT FROM ${effort}
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function touchSessionUpdatedAt(
    sql: Sql,
    id: string,
    updatedAt: number,
    namespace: string
): Promise<boolean> {
    try {
        const result = await sql`
            UPDATE sessions
            SET updated_at = ${updatedAt},
                seq = seq + 1
            WHERE id = ${id}
              AND namespace = ${namespace}
              AND updated_at < ${updatedAt}
        `

        return result.count === 1
    } catch {
        return false
    }
}

export async function getSession(sql: Sql, id: string): Promise<StoredSession | null> {
    const rows = await sql`SELECT * FROM sessions WHERE id = ${id}`
    const row = rows[0] as DbSessionRow | undefined
    return row ? toStoredSession(row) : null
}

export async function getSessionByNamespace(sql: Sql, id: string, namespace: string): Promise<StoredSession | null> {
    const rows = await sql`SELECT * FROM sessions WHERE id = ${id} AND namespace = ${namespace}`
    const row = rows[0] as DbSessionRow | undefined
    return row ? toStoredSession(row) : null
}

export async function getSessions(sql: Sql): Promise<StoredSession[]> {
    const rows = await sql`SELECT * FROM sessions ORDER BY updated_at DESC`
    return (rows as unknown as DbSessionRow[]).map(toStoredSession)
}

export async function getSessionsByNamespace(sql: Sql, namespace: string): Promise<StoredSession[]> {
    const rows = await sql`SELECT * FROM sessions WHERE namespace = ${namespace} ORDER BY updated_at DESC`
    return (rows as unknown as DbSessionRow[]).map(toStoredSession)
}

export async function deleteSession(sql: Sql, id: string, namespace: string): Promise<boolean> {
    const result = await sql`DELETE FROM sessions WHERE id = ${id} AND namespace = ${namespace}`
    return result.count > 0
}
