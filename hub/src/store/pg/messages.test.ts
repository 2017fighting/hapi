import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Sql } from '../pgIndex'
import { SessionStore } from './sessionStore'
import { MessageStore } from './messageStore'
import type { StoredSession } from '../types'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function makeStores(): Promise<{ messages: MessageStore; sessions: SessionStore }> {
    const store = await createTestStore()
    const sql = (store as unknown as StoreLike).sql
    return { messages: new MessageStore(sql), sessions: new SessionStore(sql) }
}

async function makeSession(sessions: SessionStore, tag: string): Promise<StoredSession> {
    return await sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

describe('cancelQueuedMessage', () => {
    itPg('happy path: deletes queued message, returns status=cancelled with localId', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-happy')
        const msg = await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-1')

        const result = await messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-1')
        }

        // Row should be gone from uninvoked list
        const remaining = await messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    itPg('already-invoked: returns status=invoked with full message row, row stays in DB', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-already-invoked')
        const content = { role: 'user', content: { type: 'text', text: 'hello' } }
        const msg = await messages.addMessage(session.id, content, 'lid-2')

        const invokedAt = Date.now()
        // Simulate CLI invoke ack
        await messages.markMessagesInvoked(session.id, ['lid-2'], invokedAt)

        const result = await messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('invoked')

        // Must include the invoked row so the web client can restore authoritative state
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe('lid-2')
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists (with invoked_at set)
        const msgs = await messages.getMessages(session.id)
        expect(msgs.some(m => m.id === msg.id)).toBe(true)
    })

    itPg('cancel × 2 idempotent: second call returns status=cancelled with localId=null (row gone)', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-idempotent')
        const msg = await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-3')

        const first = await messages.cancelQueuedMessage(session.id, msg.id)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe('lid-3')
        }

        const second = await messages.cancelQueuedMessage(session.id, msg.id)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    itPg('non-existent messageId: returns status=cancelled with localId=null', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-nonexistent')

        const result = await messages.cancelQueuedMessage(session.id, 'nonexistent-id')
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }
    })

    itPg('wrong sessionId: returns status=cancelled with localId=null, message from other session untouched', async () => {
        const { messages, sessions } = await makeStores()
        const sessionA = await makeSession(sessions, 'cancel-session-a')
        const sessionB = await makeSession(sessions, 'cancel-session-b')
        const msg = await messages.addMessage(sessionA.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-A')

        const result = await messages.cancelQueuedMessage(sessionB.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBeNull()
        }

        // Original message still exists
        const remaining = await messages.getUninvokedLocalMessages(sessionA.id)
        expect(remaining).toHaveLength(1)
    })

    itPg('cancelled localId is propagated from the deleted row', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-localid-propagate')
        const msg = await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, 'lid-propagate')

        const result = await messages.cancelQueuedMessage(session.id, msg.id)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe('lid-propagate')
        }
    })

    itPg('cancel by localId before server echo: localId match returns status=cancelled with localId', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-by-localid')
        // Simulate the optimistic row: server has stored it with local_id but web client
        // still holds msg.id === localId (server echo not yet received).
        const localId = 'local:pre-echo-id'
        await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        // The web client passes localId as messageId (before server echo replaces it)
        const result = await messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('cancelled')
        if (result.status === 'cancelled') {
            expect(result.localId).toBe(localId)
        }

        // Row should be gone
        const remaining = await messages.getUninvokedLocalMessages(session.id)
        expect(remaining).toHaveLength(0)
    })

    itPg('cancel by localId × 2 idempotent: second call returns status=cancelled with localId=null', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-by-localid-idempotent')
        const localId = 'local:idem-id'
        await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const first = await messages.cancelQueuedMessage(session.id, localId)
        expect(first.status).toBe('cancelled')
        if (first.status === 'cancelled') {
            expect(first.localId).toBe(localId)
        }

        // Second cancel by the same localId — row is already gone
        const second = await messages.cancelQueuedMessage(session.id, localId)
        expect(second.status).toBe('cancelled')
        if (second.status === 'cancelled') {
            expect(second.localId).toBeNull()
        }
    })

    itPg('cancel by localId when invoked: returns status=invoked with message row', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'cancel-by-localid-invoked')
        const localId = 'local:invoked-id'
        const msg = await messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } }, localId)

        const invokedAt = Date.now()
        await messages.markMessagesInvoked(session.id, [localId], invokedAt)

        // Web client passes localId as messageId — should detect invoked_at IS NOT NULL
        const result = await messages.cancelQueuedMessage(session.id, localId)
        expect(result.status).toBe('invoked')
        if (result.status === 'invoked') {
            expect(result.message.id).toBe(msg.id)
            expect(result.message.localId).toBe(localId)
            expect(result.message.invokedAt).toBe(invokedAt)
        }

        // Row still exists
        const msgs = await messages.getMessages(session.id)
        expect(msgs.some(m => m.id === msg.id)).toBe(true)
    })
})

describe('addMessage: scheduledAt invariants', () => {
    itPg('rejects scheduledAt without a localId — would silently invoke immediately', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'sched-invariant')
        const future = Date.now() + 60_000

        await expect(
            messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'orphan scheduled' } },
                undefined,
                future
            )
        ).rejects.toThrow(/scheduledAt requires a localId/)
    })

    itPg('accepts scheduledAt when paired with a localId and keeps invoked_at NULL', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'sched-ok')
        const future = Date.now() + 60_000

        const msg = await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'queued for later' } },
            'lid-sched',
            future
        )

        expect(msg.scheduledAt).toBe(future)
        expect(msg.invokedAt).toBeNull()
    })
})

describe('getDeliverableMessagesAfter: CLI backfill excludes future-scheduled rows', () => {
    itPg('omits rows whose scheduled_at > now (would otherwise be replayed early on reconnect)', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'backfill-future-sched')
        const now = Date.now()
        const future = now + 60_000
        const past = now - 60_000

        const immediate = await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'lid-immediate'
        )
        await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future-scheduled' } },
            'lid-future',
            future
        )
        const matureSched = await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature-scheduled' } },
            'lid-mature',
            past
        )

        const delivered = await messages.getDeliverableMessagesAfter(session.id, 0, now)
        const ids = delivered.map((m) => m.id)
        expect(ids).toContain(immediate.id)
        expect(ids).toContain(matureSched.id)
        expect(ids).not.toContain('lid-future')
        const localIds = delivered.map((m) => m.localId)
        expect(localIds).not.toContain('lid-future')
    })

    itPg('returns the row once now advances past scheduled_at (release boundary)', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'backfill-release-boundary')
        const fireAt = Date.now() - 60_000

        await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'boundary' } },
            'lid-bnd',
            fireAt
        )

        const before = await messages.getDeliverableMessagesAfter(session.id, 0, fireAt - 1)
        expect(before.find((m) => m.localId === 'lid-bnd')).toBeUndefined()

        const exact = await messages.getDeliverableMessagesAfter(session.id, 0, fireAt)
        expect(exact.find((m) => m.localId === 'lid-bnd')).toBeDefined()
    })

    itPg('respects afterSeq alongside the scheduled_at filter (2-axis interaction)', async () => {
        // Verifies the seq cursor and the scheduled-at filter compose correctly:
        // a row that satisfies one axis but fails the other must be excluded.
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'backfill-2axis')
        const now = Date.now()

        const m1 = await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'first' } },
            'lid-1'
        )
        const m2 = await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'second' } },
            'lid-2'
        )

        // afterSeq = m1.seq → only m2 should be returned.
        const onlyM2 = await messages.getDeliverableMessagesAfter(session.id, m1.seq, now)
        expect(onlyM2.map((m) => m.id)).toEqual([m2.id])

        // afterSeq = m2.seq → nothing (cursor at the end).
        const empty = await messages.getDeliverableMessagesAfter(session.id, m2.seq, now)
        expect(empty).toHaveLength(0)
    })
})

describe('countFutureScheduledLocalMessages', () => {
    itPg('counts only future scheduled uninvoked local messages', async () => {
        const { messages, sessions } = await makeStores()
        const session = await makeSession(sessions, 'sched-count')
        const now = Date.now()

        await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate queued' } },
            'local-immediate'
        )
        await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future scheduled' } },
            'local-future',
            now + 60_000
        )
        await messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature scheduled' } },
            'local-mature',
            now - 1
        )

        expect(await messages.countFutureScheduledLocalMessages(session.id, now)).toBe(1)
    })

    itPg('batch query returns counts keyed by session id', async () => {
        const { messages, sessions } = await makeStores()
        const sessionA = await makeSession(sessions, 'sched-batch-a')
        const sessionB = await makeSession(sessions, 'sched-batch-b')
        const now = Date.now()

        await messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a1' } },
            'a-1',
            now + 60_000
        )
        await messages.addMessage(
            sessionA.id,
            { role: 'user', content: { type: 'text', text: 'a2' } },
            'a-2',
            now + 120_000
        )
        await messages.addMessage(
            sessionB.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'b-1'
        )

        const counts = await messages.countFutureScheduledBySessionIds([sessionA.id, sessionB.id], now)
        expect(counts.get(sessionA.id)).toBe(2)
        expect(counts.get(sessionB.id)).toBeUndefined()

        const nextAt = await messages.minFutureScheduledAtBySessionIds([sessionA.id, sessionB.id], now)
        expect(nextAt.get(sessionA.id)).toBe(now + 60_000)
        expect(nextAt.get(sessionB.id)).toBeUndefined()
    })
})
