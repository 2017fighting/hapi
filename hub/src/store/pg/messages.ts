import { randomUUID } from 'node:crypto'

import type { Sql } from '../pgIndex'
import type { StoredMessage } from '../types'
import { safeJsonParse } from '../json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
    invoked_at: number | null
    scheduled_at: number | null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        invokedAt: row.invoked_at ?? null,
        scheduledAt: row.scheduled_at ?? null
    }
}

export type CopyStoredMessageInput = Pick<
    StoredMessage,
    'content' | 'createdAt' | 'localId' | 'invokedAt' | 'scheduledAt'
>

export async function addMessage(
    sql: Sql,
    sessionId: string,
    content: unknown,
    localId?: string,
    scheduledAt?: number | null
): Promise<StoredMessage> {
    const now = Date.now()

    // Without a localId, invoked_at is stamped immediately below — there is no
    // ack path to flip it later.  A scheduled message in that state would be
    // skipped by the future-emit branch and never picked up by
    // getMatureScheduledMessages (which filters on invoked_at IS NULL), so
    // the schedule would be silently lost.
    if (scheduledAt != null && !localId) {
        throw new Error('addMessage: scheduledAt requires a localId for the ack flow')
    }

    if (localId) {
        const existingRows = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} AND local_id = ${localId} LIMIT 1`
        const existing = existingRows[0] as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    // NOTE: Postgres lowercases unquoted aliases, so `AS nextSeq` returns as
    // `nextseq` (SQLite preserves case). Read the lowercased key for portability.
    const msgSeqRows = await sql`SELECT COALESCE(MAX(seq), 0) + 1 AS nextseq FROM messages WHERE session_id = ${sessionId}`
    const msgSeqRow = msgSeqRows[0] as { nextseq: number }
    const msgSeq = msgSeqRow.nextseq

    const id = randomUUID()
    const json = JSON.stringify(content)

    // Messages without a localId have no ack path (markMessagesInvoked matches by localId).
    // Treat them as already-invoked at insert time so they land in the thread normally instead
    // of being stuck in the queued floating bar forever.
    const invokedAt = localId ? null : now

    await sql`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
        ) VALUES (
            ${id}, ${sessionId}, ${json}, ${now}, ${msgSeq}, ${localId ?? null}, ${invokedAt}, ${scheduledAt ?? null}
        )
    `

    const rows = await sql`SELECT * FROM messages WHERE id = ${id}`
    const row = rows[0] as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to create message')
    }
    return toStoredMessage(row)
}

export async function copyMessageToSession(
    sql: Sql,
    sessionId: string,
    message: CopyStoredMessageInput
): Promise<StoredMessage> {
    const createdAt = Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
    const nextSeq = (await getMaxSeq(sql, sessionId)) + 1

    let localId = message.localId
    if (localId) {
        const collisionRows = await sql`SELECT 1 FROM messages WHERE session_id = ${sessionId} AND local_id = ${localId} LIMIT 1`
        const collision = collisionRows[0] as Record<string, unknown> | undefined
        if (collision) {
            // 中文注释：重复会话合并时如果 localId 撞车，给复制进目标会话的消息生成一个新 localId，避免误判成同一条已存在消息。
            localId = `${localId}:merged:${randomUUID().slice(0, 8)}`
        }
    }

    if (message.scheduledAt != null && !localId && message.invokedAt === null) {
        // 中文注释：未来计划消息仍需要 ack 路径；异常情况下若源数据缺少 localId，这里补一个稳定可写的新值以保留调度语义。
        localId = `merged-scheduled:${randomUUID()}`
    }

    const invokedAt = localId ? message.invokedAt : (message.invokedAt ?? createdAt)
    const id = randomUUID()
    await sql`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, invoked_at, scheduled_at
        ) VALUES (
            ${id}, ${sessionId}, ${JSON.stringify(message.content)}, ${createdAt}, ${nextSeq}, ${localId ?? null}, ${invokedAt ?? null}, ${message.scheduledAt ?? null}
        )
    `

    const rows = await sql`SELECT * FROM messages WHERE id = ${id}`
    const row = rows[0] as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to copy message into target session')
    }
    return toStoredMessage(row)
}

export async function getMessages(
    sql: Sql,
    sessionId: string,
    limit: number = 200
): Promise<StoredMessage[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT ${safeLimit}`

    return (rows as unknown as DbMessageRow[]).slice().reverse().map(toStoredMessage)
}

export async function getAllMessages(
    sql: Sql,
    sessionId: string
): Promise<StoredMessage[]> {
    const rows = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY seq ASC`
    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

export async function getFirstMessages(
    sql: Sql,
    sessionId: string,
    limit: number = 50
): Promise<StoredMessage[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50

    const rows = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY seq ASC LIMIT ${safeLimit}`

    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

/** CLI reconnect backfill: returns messages above the seq cursor that are
 *  deliverable now, i.e. excludes future-scheduled rows (scheduled_at > now).
 *  Without this filter, a CLI reconnect between schedule time and release time
 *  would replay future-scheduled rows via the normal message stream and the
 *  runner would consume them immediately, bypassing the mature-scan path.
 *  Only the CLI backfill route should use this; the Web thread API still calls
 *  byPosition / getMessages and needs the full set so scheduled rows surface in
 *  the queued floating bar. */
export async function getDeliverableMessagesAfter(
    sql: Sql,
    sessionId: string,
    afterSeq: number,
    now: number,
    limit: number = 200
): Promise<StoredMessage[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = await sql`
        SELECT * FROM messages
        WHERE session_id = ${sessionId}
          AND seq > ${safeAfterSeq}
          AND (scheduled_at IS NULL OR scheduled_at <= ${now})
        ORDER BY seq ASC
        LIMIT ${safeLimit}
    `

    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

/** Paginate messages by COALESCE(invoked_at, created_at) DESC, seq DESC.
 *  Results are returned in ascending display order.
 *
 *  SPECIAL CASE 4 (brief): do NOT build the before-clause by string concat.
 *  Branch into two static templates instead. */
export async function getMessagesByPosition(
    sql: Sql,
    sessionId: string,
    limit: number,
    before?: { at: number; seq: number }
): Promise<StoredMessage[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    let rows: DbMessageRow[]
    if (before) {
        rows = await sql`
            SELECT *, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ${sessionId}
              AND (COALESCE(invoked_at, created_at) < ${before.at}
                   OR (COALESCE(invoked_at, created_at) = ${before.at} AND seq < ${before.seq}))
            ORDER BY position_at DESC, seq DESC
            LIMIT ${safeLimit}
        ` as unknown as DbMessageRow[]
    } else {
        rows = await sql`
            SELECT *, COALESCE(invoked_at, created_at) AS position_at
            FROM messages
            WHERE session_id = ${sessionId}
            ORDER BY position_at DESC, seq DESC
            LIMIT ${safeLimit}
        ` as unknown as DbMessageRow[]
    }
    // Reverse so results are in ascending display order (oldest first)
    return rows.slice().reverse().map(toStoredMessage)
}

/** Returns user messages that have a localId but no invoked_at.
 *  Includes future scheduled messages — used to surface all queued messages
 *  (including scheduled) for the Web floating bar on refresh / secondary clients. */
export async function getUninvokedLocalMessages(
    sql: Sql,
    sessionId: string
): Promise<StoredMessage[]> {
    const rows = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC`
    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

/** Returns scheduled messages across all sessions whose scheduled_at <= beforeTime
 *  and have not yet been invoked.  Used by the hub tick to emit mature messages to CLI.
 *  Ordered by scheduled_at ASC (oldest first). */
export async function getMatureScheduledMessages(
    sql: Sql,
    beforeTime: number
): Promise<StoredMessage[]> {
    const rows = await sql`SELECT * FROM messages WHERE scheduled_at IS NOT NULL AND scheduled_at <= ${beforeTime} AND invoked_at IS NULL ORDER BY scheduled_at ASC`
    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

/** Returns immediate-queued local messages for a session — i.e. rows that have
 *  no scheduled_at (scheduled_at IS NULL).  Used by the session-end sweep
 *  (sweepImmediateQueuedOnSessionEnd): these are messages the user posted to a
 *  CLI session that ended before the runner consumed them, so they cannot ever
 *  be delivered and must be force-invoked to clear the floating bar.
 *
 *  Scheduled rows (scheduled_at IS NOT NULL) are *deliberately excluded*, mature
 *  or not.  The mature-scan path (releaseMatureScheduledMessages) is the sole
 *  emit channel for scheduled rows and it does not write invoked_at — the CLI
 *  ack does.  If the session-end sweep stamped a mature scheduled row as
 *  invoked, a subsequent CLI re-attach would never see the row in the
 *  mature-scan results (it filters on invoked_at IS NULL), and the user's
 *  scheduled prompt would be silently dropped.  See HAPI Bot R4 finding. */
export async function getImmediateQueuedLocalMessages(
    sql: Sql,
    sessionId: string
): Promise<StoredMessage[]> {
    const rows = await sql`
        SELECT * FROM messages
        WHERE session_id = ${sessionId}
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NULL
        ORDER BY seq ASC
    `
    return (rows as unknown as DbMessageRow[]).map(toStoredMessage)
}

/**
 * Total messages persisted for a session - any role, any state (including
 * future-scheduled and never-invoked queued rows). Used as the
 * "is this session non-trivial?" signal for the cursor migrator's size
 * sanity check; intentionally broad so a session with 6 000 unread agent
 * outputs and zero invoked user turns still counts as non-trivial.
 * tiann/hapi#872.
 */
export async function countMessages(sql: Sql, sessionId: string): Promise<number> {
    const rows = await sql`SELECT COUNT(*) AS count FROM messages WHERE session_id = ${sessionId}`
    const row = rows[0] as { count: number } | undefined
    return row?.count ?? 0
}

/** Count uninvoked local messages scheduled for a future time (session list indicator). */
export async function countFutureScheduledLocalMessages(
    sql: Sql,
    sessionId: string,
    now: number
): Promise<number> {
    const rows = await sql`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ${sessionId}
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ${now}
    `
    const row = rows[0] as { count: number } | undefined
    return row?.count ?? 0
}

/** Batch variant for GET /sessions — one query for all session IDs in a namespace.
 *
 *  SPECIAL CASE 1 (brief, R9): use `IN ${sql(ids)}` — porsager expands the array.
 *  Short-circuit on empty ids before the query so we never produce `IN ()`. */
export async function countFutureScheduledBySessionIds(
    sql: Sql,
    sessionIds: string[],
    now: number
): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    if (sessionIds.length === 0) {
        return counts
    }

    const rows = await sql`
        SELECT session_id, COUNT(*) AS count
        FROM messages
        WHERE session_id IN ${sql(sessionIds)}
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ${now}
        GROUP BY session_id
    ` as unknown as Array<{ session_id: string; count: number }>

    for (const row of rows) {
        counts.set(row.session_id, row.count)
    }
    return counts
}

/** Earliest future scheduled_at per session (session-list clock tooltip).
 *
 *  SPECIAL CASE 1 (brief, R9): use `IN ${sql(ids)}` — porsager expands the array. */
export async function minFutureScheduledAtBySessionIds(
    sql: Sql,
    sessionIds: string[],
    now: number
): Promise<Map<string, number>> {
    const nextAt = new Map<string, number>()
    if (sessionIds.length === 0) {
        return nextAt
    }

    const rows = await sql`
        SELECT session_id, MIN(scheduled_at) AS next_at
        FROM messages
        WHERE session_id IN ${sql(sessionIds)}
          AND invoked_at IS NULL
          AND local_id IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at > ${now}
        GROUP BY session_id
    ` as unknown as Array<{ session_id: string; next_at: number }>

    for (const row of rows) {
        nextAt.set(row.session_id, row.next_at)
    }
    return nextAt
}

export async function getMaxSeq(sql: Sql, sessionId: string): Promise<number> {
    // NOTE: Postgres lowercases unquoted aliases — `AS maxSeq` returns as `maxseq`.
    const rows = await sql`SELECT COALESCE(MAX(seq), 0) AS maxseq FROM messages WHERE session_id = ${sessionId}`
    const row = rows[0] as { maxseq: number } | undefined
    return row?.maxseq ?? 0
}

export type CancelQueuedMessageResult =
    | { status: 'cancelled'; localId: string | null }
    | { status: 'invoked'; message: StoredMessage }

/** Delete a queued (invoked_at IS NULL) message by session + message id.
 *
 * Runs inside a transaction to eliminate the SELECT-then-DELETE race window.
 * Returns a discriminated union so callers can distinguish two zero-delete cases:
 *   - 'cancelled': row was absent (already cancelled, or wrong id/session) — treat as success.
 *   - 'invoked':   row exists but invoked_at IS NOT NULL (CLI consumed it first) —
 *                  caller must revert any optimistic removal using the returned row,
 *                  not a stale client-side snapshot, so invokedAt is authoritative.
 *
 * The invoked_at IS NULL guard ensures cancel and invoke are mutually exclusive at
 * the DB level (first-write-wins, mirrors markMessagesInvoked).
 *
 * SPECIAL CASE 2 (brief, R7): replace SQLite's `db.transaction(() => …)()` with
 * `await sql.begin(async tx => { …; return result })`. */
export async function cancelQueuedMessage(
    sql: Sql,
    sessionId: string,
    messageId: string
): Promise<CancelQueuedMessageResult> {
    return await sql.begin(async (tx) => {
        // Accept either the server-assigned uuid (id) or the client localId.
        // This handles the pre-echo window where the web client still holds
        // msg.id === localId and passes that as the messageId parameter.
        // Note: local_id = ? evaluates to NULL (no match) when local_id IS NULL,
        // which is safe — messages without a localId are inserted with invoked_at set
        // and are never queued, so they cannot reach this code path anyway.
        const rows = await tx`
            SELECT * FROM messages
            WHERE session_id = ${sessionId} AND (id = ${messageId} OR local_id = ${messageId})
            LIMIT 1
        `
        const row = rows[0] as DbMessageRow | undefined

        if (!row) {
            // Row absent: already cancelled or wrong id — fold into 'cancelled'
            return { status: 'cancelled' as const, localId: null }
        }

        if (row.invoked_at !== null) {
            // CLI already consumed this message before the cancel arrived.
            // Return the full row so the web client can restore authoritative invoked state
            // rather than reverting to a stale queued snapshot (invokedAt: null).
            return { status: 'invoked' as const, message: toStoredMessage(row) }
        }

        await tx`
            DELETE FROM messages
            WHERE session_id = ${sessionId} AND (id = ${messageId} OR local_id = ${messageId}) AND invoked_at IS NULL
        `

        return { status: 'cancelled' as const, localId: row.local_id }
    })
}

export type LookupQueuedMessageResult =
    | { status: 'absent' }
    | { status: 'invoked'; message: StoredMessage }
    | { status: 'queued'; localId: string | null; resolvedId: string; scheduledAt: number | null }

/** Look up a queued message without deleting it.
 *
 * Returns one of three discriminated states:
 *   - 'absent':  row not found (already cancelled or wrong id).
 *   - 'invoked': row exists but invoked_at IS NOT NULL (CLI consumed it first).
 *   - 'queued':  row exists and is cancellable; resolvedId is the server-assigned uuid.
 *
 * Used by the service layer to inspect state before issuing a CLI ack round-trip.
 * The actual DELETE (after CLI ack) is performed by deleteQueuedMessageById. */
export async function lookupQueuedMessage(
    sql: Sql,
    sessionId: string,
    messageId: string
): Promise<LookupQueuedMessageResult> {
    const rows = await sql`
        SELECT * FROM messages
        WHERE session_id = ${sessionId} AND (id = ${messageId} OR local_id = ${messageId})
        LIMIT 1
    `
    const row = rows[0] as DbMessageRow | undefined

    if (!row) {
        return { status: 'absent' as const }
    }

    if (row.invoked_at !== null) {
        return { status: 'invoked' as const, message: toStoredMessage(row) }
    }

    return { status: 'queued' as const, localId: row.local_id, resolvedId: row.id, scheduledAt: row.scheduled_at }
}

/** Delete a queued (invoked_at IS NULL) message by id or local_id.
 *
 * This is the "confirmed DELETE" step after the service layer has received a
 * CLI ack with removed:true.  Uses the same first-write-wins guard as the
 * original cancelQueuedMessage. */
export async function deleteQueuedMessageById(
    sql: Sql,
    sessionId: string,
    messageId: string
): Promise<void> {
    await sql`
        DELETE FROM messages
        WHERE session_id = ${sessionId} AND (id = ${messageId} OR local_id = ${messageId}) AND invoked_at IS NULL
    `
}

/** Mark messages as invoked at the given server timestamp.
 *  Only updates rows whose local_id is in localIds.
 *  First-write-wins: rows with a non-NULL invoked_at are not updated.  A duplicate
 *  ack (e.g. a CLI re-emit) would otherwise re-stamp the timestamp and shuffle
 *  the message's position in the byPosition-ordered thread.
 *
 *  SPECIAL CASE 1 (brief, R9): use `IN ${sql(localIds)}` — porsager expands the array.
 *  Early-returns if localIds is empty so we never produce `IN ()`. */
export async function markMessagesInvoked(
    sql: Sql,
    sessionId: string,
    localIds: string[],
    invokedAt: number
): Promise<void> {
    if (localIds.length === 0) return
    await sql`
        UPDATE messages
        SET invoked_at = ${invokedAt}
        WHERE session_id = ${sessionId}
          AND local_id IN ${sql(localIds)}
          AND invoked_at IS NULL
    `
}

/** SPECIAL CASE 3 (brief, R8): the SQLite impl does `db.exec('BEGIN') … COMMIT` /
 *  `ROLLBACK` with a try/catch.  Replace the whole block with one
 *  `await sql.begin(async tx => { …; return { moved, oldMaxSeq, newMaxSeq } })`.
 *  Drop the try/catch — porsager auto-rolls-back on throw and rethrows.
 *
 *  The collision UPDATE uses SPECIAL CASE 1 (R9): `IN ${sql(localIds)}`. */
export async function mergeSessionMessages(
    sql: Sql,
    fromSessionId: string,
    toSessionId: string
): Promise<{ moved: number; oldMaxSeq: number; newMaxSeq: number }> {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = await getMaxSeq(sql, fromSessionId)
    const newMaxSeq = await getMaxSeq(sql, toSessionId)

    return await sql.begin(async (tx) => {
        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            await tx`UPDATE messages SET seq = seq + ${oldMaxSeq} WHERE session_id = ${toSessionId}`
        }

        const collisionRows = await tx`
            SELECT local_id FROM messages
            WHERE session_id = ${toSessionId} AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ${fromSessionId} AND local_id IS NOT NULL
        ` as unknown as Array<{ local_id: string }>

        if (collisionRows.length > 0) {
            const localIds = collisionRows.map((row) => row.local_id)
            // Force-invoke the older copy: clearing local_id severs its ack path
            // (markMessagesInvoked matches by local_id), so leaving invoked_at
            // NULL would strand the row in the queued floating bar forever.
            // Use COALESCE so an already-invoked row keeps its server timestamp.
            await tx`
                UPDATE messages
                SET local_id = NULL,
                    invoked_at = COALESCE(invoked_at, created_at)
                WHERE session_id = ${fromSessionId} AND local_id IN ${sql(localIds)}
            `
        }

        const result = await tx`UPDATE messages SET session_id = ${toSessionId} WHERE session_id = ${fromSessionId}`
        return { moved: result.count, oldMaxSeq, newMaxSeq }
    })
}
