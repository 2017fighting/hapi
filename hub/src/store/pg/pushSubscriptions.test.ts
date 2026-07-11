import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Sql } from '../pgIndex'
import {
    addPushSubscription,
    getPushSubscriptionsByNamespace,
    removePushSubscription
} from './pushSubscriptions'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function getSql(): Promise<Sql> {
    const store = await createTestStore()
    return (store as unknown as StoreLike).sql
}

describe('addPushSubscription', () => {
    itPg('creates a new subscription row', async () => {
        const sql = await getSql()
        const before = Date.now()
        await addPushSubscription(sql, 'default', {
            endpoint: 'https://example.com/push/1',
            p256dh: 'p256dh-1',
            auth: 'auth-1'
        })
        const rows = await getPushSubscriptionsByNamespace(sql, 'default')
        expect(rows.length).toBe(1)
        expect(rows[0].endpoint).toBe('https://example.com/push/1')
        expect(rows[0].p256dh).toBe('p256dh-1')
        expect(rows[0].auth).toBe('auth-1')
        expect(rows[0].createdAt).toBeGreaterThanOrEqual(before)
    })

    itPg('upserts on duplicate (namespace, endpoint) — updates p256dh/auth/created_at', async () => {
        const sql = await getSql()
        const endpoint = 'https://example.com/push/upsert'
        await addPushSubscription(sql, 'default', {
            endpoint,
            p256dh: 'p256dh-original',
            auth: 'auth-original'
        })
        // Allow created_at to advance so we can assert it was updated.
        const beforeSecond = Date.now()
        await addPushSubscription(sql, 'default', {
            endpoint,
            p256dh: 'p256dh-updated',
            auth: 'auth-updated'
        })
        const rows = await getPushSubscriptionsByNamespace(sql, 'default')
        expect(rows.length).toBe(1) // still one row — UPSERT, not insert
        expect(rows[0].p256dh).toBe('p256dh-updated')
        expect(rows[0].auth).toBe('auth-updated')
        expect(rows[0].createdAt).toBeGreaterThanOrEqual(beforeSecond)
    })
})

describe('getPushSubscriptionsByNamespace', () => {
    itPg('returns only rows for the given namespace, ordered by created_at DESC', async () => {
        const sql = await getSql()
        await addPushSubscription(sql, 'ns-a', {
            endpoint: 'https://example.com/a/1',
            p256dh: 'k1',
            auth: 'a1'
        })
        await addPushSubscription(sql, 'ns-b', {
            endpoint: 'https://example.com/b/1',
            p256dh: 'k2',
            auth: 'a2'
        })
        await addPushSubscription(sql, 'ns-a', {
            endpoint: 'https://example.com/a/2',
            p256dh: 'k3',
            auth: 'a3'
        })
        const rows = await getPushSubscriptionsByNamespace(sql, 'ns-a')
        expect(rows.length).toBe(2)
        // DESC ordering: the most recently inserted row comes first.
        expect(rows[0].endpoint).toBe('https://example.com/a/2')
        expect(rows[1].endpoint).toBe('https://example.com/a/1')
    })

    itPg('returns an empty array for an unknown namespace', async () => {
        const sql = await getSql()
        const rows = await getPushSubscriptionsByNamespace(sql, 'no-such-namespace')
        expect(rows).toEqual([])
    })
})

describe('removePushSubscription', () => {
    itPg('removes the matching (namespace, endpoint) row', async () => {
        const sql = await getSql()
        await addPushSubscription(sql, 'default', {
            endpoint: 'https://example.com/rm/1',
            p256dh: 'k',
            auth: 'a'
        })
        await removePushSubscription(sql, 'default', 'https://example.com/rm/1')
        const rows = await getPushSubscriptionsByNamespace(sql, 'default')
        expect(rows.length).toBe(0)
    })

    itPg('is a no-op when the row does not exist (no throw)', async () => {
        const sql = await getSql()
        // Just verify it doesn't throw.
        await removePushSubscription(sql, 'default', 'https://example.com/never-existed')
    })
})
