import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Sql } from '../pgIndex'
import {
    addUser,
    getUser,
    getUsersByPlatform,
    getUsersByPlatformAndNamespace,
    removeUser
} from './users'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function getSql(): Promise<Sql> {
    const store = await createTestStore()
    return (store as unknown as StoreLike).sql
}

describe('addUser', () => {
    itPg('creates a new user and returns the stored row', async () => {
        const sql = await getSql()
        const before = Date.now()
        const user = await addUser(sql, 'slack', 'U123', 'default')
        const after = Date.now()
        expect(user.platform).toBe('slack')
        expect(user.platformUserId).toBe('U123')
        expect(user.namespace).toBe('default')
        expect(typeof user.id).toBe('number')
        expect(user.createdAt).toBeGreaterThanOrEqual(before)
        expect(user.createdAt).toBeLessThanOrEqual(after)
    })

    itPg('is idempotent on duplicate (platform, platform_user_id) — ON CONFLICT DO NOTHING', async () => {
        const sql = await getSql()
        const first = await addUser(sql, 'slack', 'Udup', 'default')
        // Second call with same platform/platform_user_id but different namespace
        // must NOT throw and must return the pre-existing row.
        const second = await addUser(sql, 'slack', 'Udup', 'other')
        expect(second.id).toBe(first.id)
        // ON CONFLICT DO NOTHING keeps the original namespace.
        expect(second.namespace).toBe('default')
    })
})

describe('getUser', () => {
    itPg('returns the stored user when found', async () => {
        const sql = await getSql()
        await addUser(sql, 'slack', 'Ufound', 'default')
        const row = await getUser(sql, 'slack', 'Ufound')
        expect(row).not.toBeNull()
        expect(row?.platformUserId).toBe('Ufound')
    })

    itPg('returns null when not found', async () => {
        const sql = await getSql()
        const row = await getUser(sql, 'slack', 'Uabsent')
        expect(row).toBeNull()
    })
})

describe('getUsersByPlatform', () => {
    itPg('returns users for the given platform ordered by created_at ASC', async () => {
        const sql = await getSql()
        const a = await addUser(sql, 'slack', 'Upf-a', 'default')
        // ensure second row has a strictly later created_at
        const b = await addUser(sql, 'slack', 'Upf-b', 'team1')
        const rows = await getUsersByPlatform(sql, 'slack')
        const ids = rows.map((r) => r.id)
        expect(ids).toContain(a.id)
        expect(ids).toContain(b.id)
        // ASC ordering: a was inserted first
        const idxA = ids.indexOf(a.id)
        const idxB = ids.indexOf(b.id)
        expect(idxA).toBeLessThan(idxB)
    })

    itPg('returns an empty array when no users match the platform', async () => {
        const sql = await getSql()
        const rows = await getUsersByPlatform(sql, 'no-such-platform')
        expect(rows).toEqual([])
    })
})

describe('getUsersByPlatformAndNamespace', () => {
    itPg('filters by both platform and namespace', async () => {
        const sql = await getSql()
        await addUser(sql, 'slack', 'Uns-a', 'team1')
        await addUser(sql, 'slack', 'Uns-b', 'team2')
        const rows = await getUsersByPlatformAndNamespace(sql, 'slack', 'team1')
        expect(rows.length).toBe(1)
        expect(rows[0].platformUserId).toBe('Uns-a')
        expect(rows[0].namespace).toBe('team1')
    })
})

describe('removeUser', () => {
    itPg('removes the user and returns true when present', async () => {
        const sql = await getSql()
        await addUser(sql, 'slack', 'Urm', 'default')
        const removed = await removeUser(sql, 'slack', 'Urm')
        expect(removed).toBe(true)
        // Verify the row is gone.
        expect(await getUser(sql, 'slack', 'Urm')).toBeNull()
    })

    itPg('returns false when the user does not exist', async () => {
        const sql = await getSql()
        const removed = await removeUser(sql, 'slack', 'Unotthere')
        expect(removed).toBe(false)
    })
})
