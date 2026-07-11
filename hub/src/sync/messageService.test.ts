/**
 * MessageService.cancelQueuedMessage race scenario tests
 *
 * Race-A: CLI ack returns { removed: true }  → DB DELETE + status='cancelled'
 * Race-B: CLI ack returns { removed: false } (already shift()-ed) → markMessagesInvoked + status='invoked'
 * Race-C: CLI ack times out (500 ms)         → markMessagesInvoked + status='invoked'
 * Race-D (CLI offline): no CLI socket in room → immediate DELETE, message-cancelled emit, no ack call
 * Race-E (partial ack): broadcast ack receives err + [{ removed: true }] → DELETE + status='cancelled'
 */
import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../store/testStore'
import { Store } from '../store'
import type { Sql } from '../store/pgIndex'
import { SessionStore } from '../store/pg/sessionStore'
import { MessageStore } from '../store/pg/messageStore'
import type { StoredSession } from '../store/types'
import { MessageService } from './messageService'
import type { Server } from 'socket.io'
import type { Session, SyncEvent } from '@hapi/protocol/types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function makeStore(): Promise<Store> {
    return await createTestStore()
}

async function makeSession(store: Store, tag: string): Promise<StoredSession> {
    return await store.sessions.getOrCreateSession(tag, { path: `/tmp/${tag}` }, null, 'default')
}

function toProtocolSession(session: StoredSession): Session {
    return {
        id: session.id,
        namespace: session.namespace,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active,
        activeAt: session.activeAt ?? session.updatedAt,
        metadata: {
            path: `/tmp/${session.tag ?? session.id}`,
            host: 'localhost'
        },
        metadataVersion: session.metadataVersion,
        agentState: null,
        agentStateVersion: session.agentStateVersion,
        thinking: false,
        thinkingAt: session.updatedAt,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort,
        serviceTier: session.serviceTier,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
}

type AckCallback = (err: Error | null, responses: Array<{ removed: boolean }>) => void

function makeIo(onEmit: (ack: AckCallback) => void, socketCount = 1): Server {
    const broadcastRoom = {
        timeout: (_ms: number) => ({
            emit: (_event: string, _data: unknown, callback: AckCallback) => {
                onEmit(callback)
            }
        }),
        emit: () => {}
    }

    // Pre-built set reused on every rooms.get() call (socketCount=0 → undefined)
    const socketSet = socketCount > 0
        ? new Set(Array.from({ length: socketCount }, (_, i) => `socket-${i}`))
        : undefined

    return {
        of: (_ns: string) => ({
            to: (_room: string) => broadcastRoom,
            adapter: { rooms: { get: (_roomName: string) => socketSet } }
        })
    } as unknown as Server
}

function makePublisher() {
    const events: SyncEvent[] = []
    return {
        emit: (event: SyncEvent) => { events.push(event) },
        events
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageService goal status filtering', () => {
    function redundantGoalStatusContent(message: string): unknown {
        return {
            role: 'agent',
            content: {
                id: `event-${message}`,
                type: 'event',
                data: { type: 'message', message }
            }
        }
    }

    itPg('hides stored redundant goal status events but keeps actionable goal messages', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'goal-status-filter')

        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
        await store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active · 8016 tokens'))
        await store.messages.addMessage(session.id, redundantGoalStatusContent('No goal to clear'))

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const page = await service.getMessagesPage(session.id, { limit: 10, before: null })

        expect(page.messages.map(message => message.content)).toEqual([
            { role: 'user', content: { type: 'text', text: '/goal ship it' } },
            redundantGoalStatusContent('No goal to clear')
        ])
    })

    itPg('exports chronological visible messages and omits queued user rows', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'session-export-visible')

        const first = await store.messages.addMessage(session.id, { role: 'user', content: 'Hello' })
        const queued = await store.messages.addMessage(session.id, { role: 'user', content: 'Queued' }, 'local-queued')
        await store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active'))
        const hiddenSystem = await store.messages.addMessage(session.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'system', subtype: 'init', uuid: 'sys-init' }
            }
        })
        const second = await store.messages.addMessage(session.id, { role: 'agent', content: 'Hi' })

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const result = await service.getSessionExport(session.id, toProtocolSession(session))

        expect(result.type).toBe('success')
        if (result.type !== 'success') throw new Error('Expected success export')
        expect(result.payload.messages.map((message) => message.id)).toEqual([first.id, second.id])
        expect(result.payload.messages.some((message) => message.id === queued.id)).toBe(false)
        expect(result.payload.messages.some((message) => message.id === hiddenSystem.id)).toBe(false)
    })

    itPg('orders invoked scheduled messages by display time, not insertion seq', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'session-export-scheduled-order')

        const scheduled = await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'Scheduled' } },
            'local-scheduled',
            Date.now() + 60_000
        )
        const normal = await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'Normal' } },
            'local-normal'
        )
        await store.messages.markMessagesInvoked(session.id, ['local-normal'], 2_000)
        await store.messages.markMessagesInvoked(session.id, ['local-scheduled'], 3_000)

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const result = await service.getSessionExport(session.id, toProtocolSession(session))

        expect(result.type).toBe('success')
        if (result.type !== 'success') throw new Error('Expected success export')
        expect(result.payload.messages.map((message) => message.id)).toEqual([normal.id, scheduled.id])
    })

    itPg('returns too-large instead of truncating an export over the cap', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'session-export-cap')

        await store.messages.addMessage(session.id, { role: 'user', content: 'One' })
        await store.messages.addMessage(session.id, { role: 'agent', content: 'Two' })

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const result = await service.getSessionExport(session.id, toProtocolSession(session), 1)

        expect(result).toEqual({
            type: 'too-large',
            count: 2,
            limit: 1
        })
    })

    itPg('pages past hidden-only goal status rows', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'goal-status-pagination')

        const user = await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
        await store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active'))

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const latest = await service.getMessagesPage(session.id, { limit: 1, before: null })

        expect(latest.messages).toHaveLength(1)
        expect(latest.messages[0]?.id).toBe(user.id)
        expect(latest.page.nextBeforeSeq).toBe(user.seq)
        expect(latest.page.hasMore).toBe(false)
    })

    itPg('pages past hidden-only goal status rows in position pagination', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'goal-status-position-pagination')

        const user = await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '/goal ship it' } })
        await store.messages.addMessage(session.id, redundantGoalStatusContent('Goal active · 8016 tokens'))

        const service = new MessageService(store, makeIo(() => {}), makePublisher() as any)
        const latest = await service.getMessagesPage(session.id, { limit: 1, before: null })

        expect(latest.messages).toHaveLength(1)
        expect(latest.messages[0]?.id).toBe(user.id)
        expect(latest.page.nextBeforeSeq).toBe(user.seq)
        expect(latest.page.hasMore).toBe(false)
    })
})

describe('MessageService message pagination', () => {
    function makeService(store: Store): MessageService {
        return new MessageService(store, makeIo(() => {}), makePublisher() as any)
    }

    itPg('returns the latest page with a composite cursor', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'page-first')
        const first = await store.messages.addMessage(session.id, 'first', 'local-first')
        const second = await store.messages.addMessage(session.id, 'second', 'local-second')
        const third = await store.messages.addMessage(session.id, 'third', 'local-third')
        await store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
        await store.messages.markMessagesInvoked(session.id, ['local-second'], 2_000)
        await store.messages.markMessagesInvoked(session.id, ['local-third'], 3_000)

        const page = await makeService(store).getMessagesPage(session.id, { limit: 2, before: null })

        expect(page.messages.map((message) => message.id)).toEqual([second.id, third.id])
        expect(page.page.nextBeforeAt).toBe(2_000)
        expect(page.page.nextBeforeSeq).toBe(second.seq)
        expect(page.page.hasMore).toBe(true)
        expect(first.id).toBeDefined()
    })

    itPg('uses the composite cursor for older pages', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'page-older')
        const first = await store.messages.addMessage(session.id, 'first', 'local-first')
        const second = await store.messages.addMessage(session.id, 'second', 'local-second')
        const third = await store.messages.addMessage(session.id, 'third', 'local-third')
        await store.messages.markMessagesInvoked(session.id, ['local-first'], 1_000)
        await store.messages.markMessagesInvoked(session.id, ['local-second'], 2_000)
        await store.messages.markMessagesInvoked(session.id, ['local-third'], 3_000)

        const latest = await makeService(store).getMessagesPage(session.id, { limit: 2, before: null })
        const older = await makeService(store).getMessagesPage(session.id, {
            limit: 2,
            before: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! }
        })

        expect(older.messages.map((message) => message.id)).toEqual([first.id])
        expect(older.page.nextBeforeAt).toBe(1_000)
        expect(older.page.nextBeforeSeq).toBe(first.seq)
        expect(older.page.hasMore).toBe(false)
        expect(second.id).toBeDefined()
        expect(third.id).toBeDefined()
    })

    itPg('breaks equal timestamp ties by seq', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'page-tie')
        const first = await store.messages.addMessage(session.id, 'first', 'local-first')
        const second = await store.messages.addMessage(session.id, 'second', 'local-second')
        const third = await store.messages.addMessage(session.id, 'third', 'local-third')
        await store.messages.markMessagesInvoked(session.id, ['local-first', 'local-second', 'local-third'], 1_000)

        const latest = await makeService(store).getMessagesPage(session.id, { limit: 2, before: null })
        const older = await makeService(store).getMessagesPage(session.id, {
            limit: 2,
            before: { at: latest.page.nextBeforeAt!, seq: latest.page.nextBeforeSeq! }
        })

        expect(latest.messages.map((message) => message.id)).toEqual([second.id, third.id])
        expect(latest.page.nextBeforeAt).toBe(1_000)
        expect(latest.page.nextBeforeSeq).toBe(second.seq)
        expect(older.messages.map((message) => message.id)).toEqual([first.id])
    })

    itPg('orders scheduled queued messages by their display position without changing the cursor', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'page-scheduled')
        const scheduled = await store.messages.addMessage(session.id, 'scheduled', 'local-scheduled', Date.now() + 60_000)
        const invoked = await store.messages.addMessage(session.id, 'invoked', 'local-invoked')
        await store.messages.markMessagesInvoked(session.id, ['local-invoked'], scheduled.createdAt + 1_000)

        const page = await makeService(store).getMessagesPage(session.id, { limit: 1, before: null })

        expect(page.messages.map((message) => message.id)).toEqual([scheduled.id, invoked.id])
        expect(page.page.nextBeforeAt).toBe(scheduled.createdAt + 1_000)
        expect(page.page.nextBeforeSeq).toBe(invoked.seq)
        expect(page.page.hasMore).toBe(true)
    })
})

describe('MessageService.cancelQueuedMessage race scenarios', () => {
    describe('Race-A: CLI ack removed:true → DELETE + status=cancelled', () => {
        itPg('returns cancelled and emits message-cancelled SSE after CLI confirms removal', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-a')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-a'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // CLI confirms it removed the item
                callback(null, [{ removed: true }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('cancelled')

            // Row must be gone from the DB
            const remaining = await store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been broadcast
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()

            // No messages-consumed for cancelled path (row is deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })

    describe('Race-B: CLI ack removed:false (already shift()-ed) → markMessagesInvoked + status=invoked', () => {
        itPg('returns invoked with message row when CLI says item was already consumed', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-b')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-b'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // CLI already shifted the item before the cancel arrived
                callback(null, [{ removed: false }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            if (result.status === 'invoked') {
                expect(result.message.id).toBe(msg.id)
                expect(result.message.localId).toBe('local-b')
                expect(result.message.invokedAt).not.toBeNull()
            }

            // Row must still exist but now have invoked_at set
            const rows = await store.messages.getMessages(session.id)
            const row = rows.find(r => r.id === msg.id)
            expect(row).toBeDefined()
            expect(row!.invokedAt).not.toBeNull()

            // No message-cancelled SSE should have been emitted
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeUndefined()

            // messages-consumed SSE must be broadcast so other web clients clear the queued row
            const consumed = publisher.events.find(e => e.type === 'messages-consumed')
            expect(consumed).toBeDefined()
            if (consumed?.type === 'messages-consumed') {
                expect(consumed.sessionId).toBe(session.id)
                expect(consumed.localIds).toEqual(['local-b'])
                expect(typeof consumed.invokedAt).toBe('number')
            }

            // messages-consumed must be emitted exactly once
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(1)
        })
    })

    describe('Race-C: CLI ack timeout → markMessagesInvoked + status=invoked', () => {
        itPg('returns invoked with message row when CLI does not respond within timeout', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-c')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-c'
            )

            const publisher = makePublisher()
            const io = makeIo((callback) => {
                // Simulate timeout: socket.io passes an error as first arg
                callback(new Error('operation has timed out'), [])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            if (result.status === 'invoked') {
                expect(result.message.id).toBe(msg.id)
                expect(result.message.invokedAt).not.toBeNull()
            }

            // Row must still exist with invoked_at stamped
            const rows = await store.messages.getMessages(session.id)
            const row = rows.find(r => r.id === msg.id)
            expect(row).toBeDefined()
            expect(row!.invokedAt).not.toBeNull()

            // No message-cancelled SSE
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeUndefined()

            // messages-consumed SSE must be broadcast so other web clients clear the queued row
            const consumed = publisher.events.find(e => e.type === 'messages-consumed')
            expect(consumed).toBeDefined()
            if (consumed?.type === 'messages-consumed') {
                expect(consumed.sessionId).toBe(session.id)
                expect(consumed.localIds).toEqual(['local-c'])
                expect(typeof consumed.invokedAt).toBe('number')
            }

            // messages-consumed must be emitted exactly once
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(1)
        })
    })

    describe('Race-D: CLI offline (room socket count === 0) → immediate DELETE, no ack', () => {
        itPg('returns cancelled and emits message-cancelled without calling ack when no CLI socket is connected', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-d-offline')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-offline'
            )

            let ackCalled = false
            // socketCount=0 → adapter.rooms.get() returns undefined → cliCount = 0
            const io = makeIo(() => { ackCalled = true }, 0)
            const publisher = makePublisher()

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            // Hub must return cancelled immediately
            expect(result.status).toBe('cancelled')

            // CLI ack must NOT have been called
            expect(ackCalled).toBe(false)

            // Row must be gone from the DB (immediate DELETE)
            const remaining = await store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been emitted with localId
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()
            if (cancelled?.type === 'message-cancelled') {
                expect(cancelled.localId).toBe('local-offline')
            }

            // No messages-consumed (row was deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)

            // No invoked_at stamped (row deleted, not marked invoked)
            const rows = await store.messages.getMessages(session.id)
            expect(rows.find(r => r.id === msg.id)).toBeUndefined()
        })
    })

    describe('existing store-level invoked guard (DB first-write-wins) still respected', () => {
        itPg('returns invoked without contacting CLI when DB row already has invoked_at', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-d-already-invoked')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-d'
            )

            // DB row was already marked invoked (e.g. by a concurrent messages-consumed)
            const invokedAt = Date.now()
            await store.messages.markMessagesInvoked(session.id, ['local-d'], invokedAt)

            let cliContacted = false
            const io = makeIo(() => { cliContacted = true })
            const publisher = makePublisher()

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            expect(result.status).toBe('invoked')
            // CLI must NOT have been contacted — DB guard should short-circuit before ack
            expect(cliContacted).toBe(false)

            if (result.status === 'invoked') {
                expect(result.message.invokedAt).toBe(invokedAt)
            }

            // DB guard path: messages-consumed was already published by the prior
            // messages-consumed flow that set invoked_at.  No additional emit here.
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })

    describe('Race-E: partial ack — broadcast callback receives err + [{ removed: true }]', () => {
        itPg('returns cancelled and deletes row when at least one socket acked removal, even if err is set', async () => {
            const store = await makeStore()
            const session = await makeSession(store, 'race-e')
            const msg = await store.messages.addMessage(
                session.id,
                { role: 'user', content: { type: 'text', text: 'hello' } },
                'local-e'
            )

            const publisher = makePublisher()
            // Reconnect-overlap scenario: one socket timed out (err set by Socket.IO),
            // but the live socket confirmed removal in responses.
            const io = makeIo((callback) => {
                callback(new Error('operation has timed out'), [{ removed: true }])
            })

            const service = new MessageService(store, io, publisher as any)
            const result = await service.cancelQueuedMessage(session.id, msg.id)

            // The live socket's ack must win — cancel is confirmed
            expect(result.status).toBe('cancelled')

            // Row must be deleted
            const remaining = await store.messages.getUninvokedLocalMessages(session.id)
            expect(remaining).toHaveLength(0)

            // message-cancelled SSE must have been emitted
            const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
            expect(cancelled).toBeDefined()

            // No messages-consumed (row deleted, not invoked)
            const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
            expect(consumedCount).toBe(0)
        })
    })
})

// ---------------------------------------------------------------------------
// #1 cancel × scheduled mature race (expected behavior documentation)
// ---------------------------------------------------------------------------

describe('MessageService — cancel × mature race (scheduled messages)', () => {
    // The 5-second mature tick widens the cancel race window for scheduled
    // messages compared to immediately-queued ones.  When mature fires first,
    // the CLI shifts the row; a subsequent cancel call gets 'not-found' from
    // the CLI ack, which stamps invoked_at (PR #568 contract preserved).
    // The web client surfaces this as "sent".  This test documents that the
    // behaviour is intentional — it is the expected outcome, not a bug.
    itPg('cancel after mature-emit stamps invoked_at (race resolved as invoked — expected behavior)', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'race-sched-mature')
        const publisher = makePublisher()

        const now = Date.now()
        const past = now - 1000
        // Add a scheduled message that is already mature
        const msg = await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'sched' } },
            'local-sched-race',
            past
        )

        // Simulate: mature tick already emitted to CLI, CLI shifted the item.
        // Cancel arrives and CLI returns not-found (item already shift()-ed).
        const io = makeIo((callback) => {
            // CLI cannot remove — it already shift()-ed (mature tick beat the cancel)
            callback(null, [{ removed: false }])
        })

        const service = new MessageService(store, io, publisher as any)
        // Simulate the mature tick firing first (CLI now has the item)
        // Then cancel arrives — CLI says not-found
        const result = await service.cancelQueuedMessage(session.id, msg.id)

        // Expected behavior: invoked_at is stamped (PR #568 contract preserved)
        // Web client will show the message as "sent"
        expect(result.status).toBe('invoked')
        if (result.status === 'invoked') {
            expect(result.message.localId).toBe('local-sched-race')
            expect(result.message.invokedAt).not.toBeNull()
        }

        // messages-consumed SSE ensures web clients remove it from the queued bar
        const consumed = publisher.events.find(e => e.type === 'messages-consumed')
        expect(consumed).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// #1 cancel of future-scheduled message: must DELETE (not invoke)
// ---------------------------------------------------------------------------

describe('MessageService.cancelQueuedMessage — future-scheduled message', () => {
    // A future-scheduled message was never emitted to the CLI.
    // When the user clicks X, the hub contacts the CLI (room has sockets) and
    // CLI responds not-found — because the message was never there.
    // The hub MUST treat this as a clean delete (status='cancelled'), NOT as
    // "CLI already consumed it" (which would stamp invoked_at).
    itPg('cancel of future-scheduled msg with CLI online returns cancelled (not invoked)', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'cancel-future-sched')
        const publisher = makePublisher()

        const futureMs = Date.now() + 60_000
        const msg = await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'scheduled future' } },
            'local-future-cancel',
            futureMs
        )

        // CLI responds not-found: the message was never emitted there
        let ackCalled = false
        const io = makeIo((callback) => {
            ackCalled = true
            callback(null, [{ removed: false }])
        }, 1) // 1 CLI socket online

        const service = new MessageService(store, io, publisher as any)
        const result = await service.cancelQueuedMessage(session.id, msg.id)

        // Future-scheduled cancel must succeed as 'cancelled', not 'invoked'
        expect(result.status).toBe('cancelled')

        // Row must be gone from DB (not just invoked_at stamped)
        const rows = await store.messages.getMessages(session.id)
        const remaining = rows.find(r => r.id === msg.id)
        expect(remaining).toBeUndefined()

        // message-cancelled SSE must be emitted
        const cancelled = publisher.events.find(e => e.type === 'message-cancelled')
        expect(cancelled).toBeDefined()

        // messages-consumed (invoked path) must NOT be emitted
        const consumedCount = publisher.events.filter(e => e.type === 'messages-consumed').length
        expect(consumedCount).toBe(0)

        // invoked_at must never have been stamped (row deleted)
        // (row is gone, so we just verify the cancel result is not invoked)
        expect(result.status).not.toBe('invoked')

        // Short-circuit must have bypassed the CLI ack round-trip entirely.
        // ackCalled being false proves the future-scheduled path deleted the row
        // without ever contacting the CLI.
        expect(ackCalled).toBe(false)
    })

    itPg('cancel of future-scheduled msg when CLI offline also returns cancelled', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'cancel-future-sched-offline')
        const publisher = makePublisher()

        const futureMs = Date.now() + 60_000
        const msg = await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future offline' } },
            'local-future-offline',
            futureMs
        )

        let ackCalled = false
        const io = makeIo(() => { ackCalled = true }, 0) // CLI offline

        const service = new MessageService(store, io, publisher as any)
        const result = await service.cancelQueuedMessage(session.id, msg.id)

        expect(result.status).toBe('cancelled')
        expect(ackCalled).toBe(false)

        // Row must be deleted
        const rows = await store.messages.getMessages(session.id)
        expect(rows.find(r => r.id === msg.id)).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// sendMessage with scheduledAt
// ---------------------------------------------------------------------------

describe('MessageService.sendMessage with scheduledAt', () => {
    function makeNoopIo(): Server {
        let emittedUpdates: unknown[] = []
        return {
            of: (_ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => { emittedUpdates.push(data) },
                    timeout: (_ms: number) => ({
                        emit: () => {}
                    })
                }),
                adapter: { rooms: { get: () => undefined } }
            }),
            _emittedUpdates: emittedUpdates
        } as unknown as Server
    }

    itPg('future scheduledAt: stores message with scheduledAt, does NOT emit to /cli', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-future')
        const publisher = makePublisher()

        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server

        const futureMs = Date.now() + 60_000

        const service = new MessageService(store, io, publisher as any)
        await service.sendMessage(session.id, {
            text: 'hello future',
            localId: 'local-sched',
            scheduledAt: futureMs
        })

        // DB must have the message with scheduledAt set
        const msgs = await store.messages.getUninvokedLocalMessages(session.id)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].scheduledAt).toBe(futureMs)

        // CLI must NOT receive the message yet (future scheduled)
        expect(cliEmitted).toHaveLength(0)

        // Web SSE must still receive message-received so the bar renders
        const received = publisher.events.find(e => e.type === 'message-received')
        expect(received).toBeDefined()
    })

    itPg('null scheduledAt: immediate send, emits to /cli normally', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-null')
        const publisher = makePublisher()

        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server

        const service = new MessageService(store, io, publisher as any)
        await service.sendMessage(session.id, { text: 'immediate', localId: 'local-imm' })

        // CLI must receive the message immediately
        expect(cliEmitted).toHaveLength(1)

        // scheduledAt must be null in DB
        const msgs = await store.messages.getMessages(session.id)
        expect(msgs[0].scheduledAt).toBeNull()
    })

    itPg('past scheduledAt (already mature): emits to /cli immediately', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-past')
        const publisher = makePublisher()

        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server

        const pastMs = Date.now() - 5_000

        const service = new MessageService(store, io, publisher as any)
        await service.sendMessage(session.id, {
            text: 'past scheduled',
            localId: 'local-past',
            scheduledAt: pastMs
        })

        // Past scheduled_at is already mature → emit to CLI immediately
        expect(cliEmitted).toHaveLength(1)
    })

    // #11 TOCTOU: isFutureScheduled must use Date.now() at check time, not the
    // pre-addMessage `now` capture, to avoid a double-emit race window.
    itPg('#11 TOCTOU: scheduledAt exactly equal to Date.now() is treated as mature (not future)', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-toctou')
        const publisher = makePublisher()

        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server

        // Use a scheduledAt in the past to simulate TOCTOU: addMessage inserts
        // a row, then the post-insert check should use a fresh Date.now() which
        // is >= scheduledAt, treating it as mature and emitting to CLI.
        const scheduledAt = Date.now() - 1
        const service = new MessageService(store, io, publisher as any)
        await service.sendMessage(session.id, {
            text: 'toctou',
            localId: 'local-toctou',
            scheduledAt
        })

        // scheduledAt is in the past at emit-check time → must emit to CLI
        expect(cliEmitted).toHaveLength(1)
    })

    // Defence-in-depth: REST already rejects scheduledAt + attachments at the
    // Zod layer, but non-REST callers (Telegram bot, MCP, internal) reach
    // sendMessage directly and must hit the same invariant — otherwise the CLI
    // session's upload directory could be purged before the mature emit lands,
    // leaving @path attachment references pointing at deleted files.
    itPg('rejects sendMessage when scheduledAt is set and attachments are non-empty', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-with-attachments')
        const publisher = makePublisher()
        const service = new MessageService(store, makeNoopIo(), publisher as any)

        const futureMs = Date.now() + 60_000
        await expect(
            service.sendMessage(session.id, {
                text: 'hello',
                localId: 'local-att',
                scheduledAt: futureMs,
                attachments: [{
                    id: 'att-1',
                    filename: 'a.png',
                    mimeType: 'image/png',
                    size: 10,
                    path: '/tmp/a.png'
                }]
            })
        ).rejects.toThrow(/scheduled messages with attachments/)

        // Row must NOT have been inserted (throw is the first statement).
        const msgs = await store.messages.getUninvokedLocalMessages(session.id)
        expect(msgs).toHaveLength(0)
    })

    itPg('accepts sendMessage with scheduledAt and an empty attachments array', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'sched-empty-attachments')
        const publisher = makePublisher()
        const service = new MessageService(store, makeNoopIo(), publisher as any)

        const futureMs = Date.now() + 60_000
        await service.sendMessage(session.id, {
            text: 'hello',
            localId: 'local-att-2',
            scheduledAt: futureMs,
            attachments: []
        })

        const msgs = await store.messages.getUninvokedLocalMessages(session.id)
        expect(msgs).toHaveLength(1)
    })
})

// ---------------------------------------------------------------------------
// releaseMatureScheduledMessages
// ---------------------------------------------------------------------------

describe('MessageService.releaseMatureScheduledMessages', () => {
    function makeTrackingIo(): { io: Server; cliEmitted: unknown[] } {
        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server
        return { io, cliEmitted }
    }

    itPg('emits mature messages to /cli', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-emit')
        const publisher = makePublisher()
        const { io, cliEmitted } = makeTrackingIo()

        const now = Date.now()
        const past = now - 1000
        // Insert mature scheduled message directly via store
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-r', past)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)

        expect(cliEmitted).toHaveLength(1)
    })

    itPg('emits scheduled-matured once per session for web session-list refresh', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-sse')
        const publisher = makePublisher()
        const { io } = makeTrackingIo()

        const now = Date.now()
        const past = now - 1000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'one' } }, 'local-a', past)
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'two' } }, 'local-b', past)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)

        const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
        expect(matured).toEqual([{ type: 'scheduled-matured', sessionId: session.id }])
    })

    itPg('does NOT re-emit scheduled-matured on later ticks while CLI ack is pending', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-sse-no-repeat')
        const publisher = makePublisher()
        const { io } = makeTrackingIo()

        const now = Date.now()
        const past = now - 1000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-repeat', past)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)
        await service.releaseMatureScheduledMessages(now + 60_000)

        const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
        expect(matured).toHaveLength(1)
    })

    itPg('emits scheduled-matured when first scan is long after scheduled_at', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-sse-late-scan')
        const publisher = makePublisher()
        const { io } = makeTrackingIo()

        const now = Date.now()
        const past = now - 60_000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-late', past)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)

        const matured = publisher.events.filter((event) => event.type === 'scheduled-matured')
        expect(matured).toEqual([{ type: 'scheduled-matured', sessionId: session.id }])
    })

    itPg('does NOT call markMessagesInvoked (pitfall #2 guard): message is re-emitted on next tick', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-no-mark')
        const publisher = makePublisher()
        const { io, cliEmitted } = makeTrackingIo()

        const now = Date.now()
        const past = now - 1000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-nm', past)

        const service = new MessageService(store, io, publisher as any)

        // First tick
        await service.releaseMatureScheduledMessages(now)
        expect(cliEmitted).toHaveLength(1)

        // Second tick (simulating hub restart without CLI ack): must re-emit
        await service.releaseMatureScheduledMessages(now + 5_000)
        expect(cliEmitted).toHaveLength(2)

        // invoked_at must still be NULL (not marked)
        const msgs = await store.messages.getMessages(session.id)
        const msg = msgs.find(m => m.localId === 'local-nm')!
        expect(msg.invokedAt).toBeNull()
    })

    itPg('does NOT emit future scheduled messages', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-future')
        const publisher = makePublisher()
        const { io, cliEmitted } = makeTrackingIo()

        const now = Date.now()
        const future = now + 60_000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-f', future)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)

        expect(cliEmitted).toHaveLength(0)
    })

    itPg('does NOT emit already-invoked messages', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'release-invoked')
        const publisher = makePublisher()
        const { io, cliEmitted } = makeTrackingIo()

        const now = Date.now()
        const past = now - 1000
        await store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hi' } }, 'local-inv', past)
        await store.messages.markMessagesInvoked(session.id, ['local-inv'], now - 500)

        const service = new MessageService(store, io, publisher as any)
        await service.releaseMatureScheduledMessages(now)

        expect(cliEmitted).toHaveLength(0)
    })

    // #10: cold-start restart simulation — on PG, every Store.create() opens a
    // fresh handle to the SAME shared database (the test pool).  We replicate
    // the original SQLite test's semantics — a message written by one Store
    // instance must be discoverable by a second Store instance's mature scan —
    // by creating two Stores that share the underlying pool.  Unlike SQLite,
    // PG does not require a file path, so the mkdtempSync/rmSync scaffolding is
    // dropped; the shared TRUNCATE-d database is the persistence boundary.
    itPg('#10 hub cold-start restart: mature message is re-emitted by new Store+Service (true restart sim)', async () => {
        // First "run": write a mature scheduled message using a fresh Store.
        const store1 = await createTestStore()
        const session = await store1.sessions.getOrCreateSession('restart-test', { path: '/tmp/restart' }, null, 'default')
        const sessionId = session.id
        const now = Date.now()
        const past = now - 2000
        await store1.messages.addMessage(sessionId, { role: 'user', content: { type: 'text', text: 'restart me' } }, 'local-restart', past)

        // Simulate hub shutdown: close store1 (no-op for the shared test pool —
        // Store.close only ends the pool when the Store owns it, which the test
        // helper does not — but calling close preserves the original test's shape).
        await store1.close()

        // Second "run": fresh Store + fresh MessageService (cold start) on the
        // same shared database.  createTestStore() re-uses the shared pool after
        // truncating, but we bypass the truncate here by building the Store
        // directly from the shared sql so the row survives.
        const sql = (store1 as unknown as StoreLike).sql
        const store2 = await Store.create('', { sql })
        const cliEmitted: unknown[] = []
        const io2 = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server
        const publisher2 = { emit: () => {}, events: [] }

        const service2 = new MessageService(store2, io2, publisher2 as any)
        // After cold start, first tick should discover and emit the mature message
        await service2.releaseMatureScheduledMessages(now + 5_000)

        expect(cliEmitted).toHaveLength(1)

        // invoked_at must still be null (CLI hasn't acked yet)
        const msgs = await store2.messages.getMessages(sessionId)
        const msg = msgs.find(m => m.localId === 'local-restart')!
        expect(msg.invokedAt).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// HAPI Bot R4: session-end sweep must not stamp mature scheduled rows
// ---------------------------------------------------------------------------

describe('MessageService.sweepImmediateQueuedOnSessionEnd — scheduled rows are preserved', () => {
    function makeNoopIo(): Server {
        return {
            of: (_ns: string) => ({
                to: (_room: string) => ({
                    emit: () => {},
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server
    }

    function makeTrackingIo(): { io: Server; cliEmitted: unknown[] } {
        const cliEmitted: unknown[] = []
        const io = {
            of: (ns: string) => ({
                to: (_room: string) => ({
                    emit: (_event: string, data: unknown) => {
                        if (ns === '/cli') cliEmitted.push(data)
                    },
                    timeout: (_ms: number) => ({ emit: () => {} })
                }),
                adapter: { rooms: { get: () => undefined } }
            })
        } as unknown as Server
        return { io, cliEmitted }
    }

    itPg('mature scheduled row at session-end stays uninvoked and is emitted by the next mature scan', async () => {
        // R4 race scenario A: CLI dies just after scheduled_at <= now but before
        // the next 5s mature-scan tick — the sweep must NOT touch the scheduled row.
        const store = await makeStore()
        const session = await makeSession(store, 'r4-mature-sweep')
        const publisher = makePublisher()
        const now = Date.now()
        const past = now - 1000

        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'mature scheduled' } },
            'local-mature',
            past
        )

        const service = new MessageService(store, makeNoopIo(), publisher as any)

        const result = await service.sweepImmediateQueuedOnSessionEnd(session.id, now)
        expect(result).toBeNull()
        // No SSE side effect when there is nothing to sweep.
        expect(publisher.events.filter(e => e.type === 'messages-consumed')).toHaveLength(0)

        // Row is still uninvoked and still mature — the next scan picks it up.
        const stillQueued = await store.messages.getUninvokedLocalMessages(session.id)
        expect(stillQueued.find((m) => m.localId === 'local-mature')?.invokedAt).toBeNull()

        // Mature-scan tick after re-attach delivers the row.
        const { io, cliEmitted } = makeTrackingIo()
        const service2 = new MessageService(store, io, publisher as any)
        await service2.releaseMatureScheduledMessages(now)
        expect(cliEmitted).toHaveLength(1)
    })

    itPg('mature scheduled row already emitted but not yet acked stays uninvoked across session-end and is re-emitted', async () => {
        // R4 race scenario B: mature scan emits at T+0, CLI receives but dies
        // before sending messages-consumed.  Session-end fires while invoked_at
        // is still NULL.  The sweep must preserve the row (scheduled_at IS NOT
        // NULL filter) so the next mature-scan tick re-emits it — preserving the
        // documented "re-emit until ack" contract for scheduled rows.
        const store = await makeStore()
        const session = await makeSession(store, 'r4-emit-noack-sweep')
        const publisher = makePublisher()
        const now = Date.now()
        const past = now - 1000

        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'emit-noack' } },
            'local-noack',
            past
        )

        // First mature-scan emit — does NOT write invoked_at (R3 contract).
        const { io: io1, cliEmitted: emitted1 } = makeTrackingIo()
        const service1 = new MessageService(store, io1, publisher as any)
        await service1.releaseMatureScheduledMessages(now)
        expect(emitted1).toHaveLength(1)
        // Confirm invoked_at is still null (the runner crashed before acking).
        expect(
            (await store.messages.getUninvokedLocalMessages(session.id))
                .find(m => m.localId === 'local-noack')?.invokedAt
        ).toBeNull()

        // Session-end fires.  Sweep must leave the row alone.
        const sweepResult = await service1.sweepImmediateQueuedOnSessionEnd(session.id, now)
        expect(sweepResult).toBeNull()
        expect(publisher.events.filter(e => e.type === 'messages-consumed')).toHaveLength(0)
        expect(
            (await store.messages.getUninvokedLocalMessages(session.id))
                .find(m => m.localId === 'local-noack')?.invokedAt
        ).toBeNull()

        // Re-attach: next mature-scan tick re-emits the same row.
        const { io: io2, cliEmitted: emitted2 } = makeTrackingIo()
        const service2 = new MessageService(store, io2, publisher as any)
        await service2.releaseMatureScheduledMessages(now + 5000)
        expect(emitted2).toHaveLength(1)
    })

    itPg('immediate-queued (no scheduled_at) IS swept and stamped invoked at session-end', async () => {
        // Confirms the sweep still does its primary job for true immediate rows.
        const store = await makeStore()
        const session = await makeSession(store, 'r4-immediate-sweep')
        const publisher = makePublisher()
        const now = Date.now()

        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'immediate' } },
            'local-imm'
        )

        const service = new MessageService(store, makeNoopIo(), publisher as any)
        const result = await service.sweepImmediateQueuedOnSessionEnd(session.id, now)
        expect(result).not.toBeNull()
        expect(result?.localIds).toEqual(['local-imm'])

        // SSE side effect carries the swept localIds for the floating bar.
        const consumed = publisher.events.find(e => e.type === 'messages-consumed') as
            | { type: 'messages-consumed'; sessionId: string; localIds: string[]; invokedAt: number }
            | undefined
        expect(consumed).toBeDefined()
        expect(consumed?.localIds).toEqual(['local-imm'])

        // Row is now stamped — bar can clear.
        const stillQueued = await store.messages.getUninvokedLocalMessages(session.id)
        expect(stillQueued.find((m) => m.localId === 'local-imm')).toBeUndefined()
    })

    itPg('future scheduled (scheduled_at > now) is also preserved by the sweep', async () => {
        const store = await makeStore()
        const session = await makeSession(store, 'r4-future-sweep')
        const publisher = makePublisher()
        const now = Date.now()
        const future = now + 60_000

        await store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'future' } },
            'local-future',
            future
        )

        const service = new MessageService(store, makeNoopIo(), publisher as any)
        const result = await service.sweepImmediateQueuedOnSessionEnd(session.id, now)
        expect(result).toBeNull()
        expect(publisher.events.filter(e => e.type === 'messages-consumed')).toHaveLength(0)

        const stillQueued = await store.messages.getUninvokedLocalMessages(session.id)
        expect(stillQueued.find((m) => m.localId === 'local-future')?.invokedAt).toBeNull()
    })
})
