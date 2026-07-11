import { describe, expect, it } from 'bun:test'
import { createTestStore } from '../testStore'
import type { Sql } from '../pgIndex'
import { SessionStore } from './sessionStore'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

type StoreLike = { sql: Sql }

async function makeStore(): Promise<SessionStore> {
    const store = await createTestStore()
    const sql = (store as unknown as StoreLike).sql
    return new SessionStore(sql)
}

async function getMetadata(store: SessionStore, id: string): Promise<Record<string, unknown> | null> {
    const row = await store.getSession(id)
    return (row?.metadata ?? null) as Record<string, unknown> | null
}

describe('updateSessionMetadata: protocol resume token preservation', () => {
    itPg('preserves cursorSessionId when archive payload omits it (Cursor crash-archive)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-archive-cursor-id',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-abc',
                cursorSessionProtocol: 'stream-json',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                lifecycleState: 'archived',
                lifecycleStateSince: 2,
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = await getMetadata(store, session.id)
        expect(metadata).not.toBeNull()
        expect(metadata?.cursorSessionId).toBe('cursor-thread-abc')
        expect(metadata?.cursorSessionProtocol).toBe('stream-json')
        expect(metadata?.lifecycleState).toBe('archived')
        expect(metadata?.archiveReason).toBe('Session crashed')
        expect(metadata?.archivedBy).toBe('cli')
    })

    itPg('preserves codexSessionId when archive payload omits it (Codex generic flavor)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'codex-archive',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'codex-thread-1',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.codexSessionId).toBe('codex-thread-1')
    })

    itPg.each([
        ['claudeSessionId', 'claude-thread-x'],
        ['codexSessionId', 'codex-thread-x'],
        ['geminiSessionId', 'gemini-thread-x'],
        ['opencodeSessionId', 'opencode-thread-x'],
        ['cursorSessionId', 'cursor-thread-x'],
        ['kimiSessionId', 'kimi-thread-x']
    ])('preserves %s across an archive metadata replacement', async (field, value) => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            `archive-${field}`,
            {
                path: '/tmp/project',
                host: 'example',
                [field]: value
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )
        expect(result.result).toBe('success')

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.[field]).toBe(value)
    })

    itPg('preserves cursorSessionProtocol independently of cursorSessionId', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-protocol-only',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionProtocol: 'acp'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example' },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.cursorSessionProtocol).toBe('acp')
    })

    itPg('lets the next write override a flavor session id when it explicitly sets a different value', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-overwrite',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'old-thread'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'new-thread'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('new-thread')
    })

    itPg('does not invent fields when the prior row had no resume token', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'no-prior-token',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id)
        expect(metadata).not.toBeNull()
        expect('cursorSessionId' in (metadata as Record<string, unknown>)).toBe(false)
        expect('codexSessionId' in (metadata as Record<string, unknown>)).toBe(false)
    })

    itPg('preserves resume token when CLI sends an empty payload (stale-cache failure mode)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-empty-payload',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'survives-empty-payload'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('survives-empty-payload')
        expect(metadata?.lifecycleState).toBe('archived')
    })

    itPg('preserves resume token across multiple consecutive metadata writes', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-multi-write',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'persistent-thread'
            },
            null,
            'default'
        )

        const v1 = await store.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', name: 'renamed' },
            session.metadataVersion,
            'default'
        )
        expect(v1.result).toBe('success')

        const v2 = await store.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example', name: 'renamed', tools: ['read_file'] },
            v1.result === 'success' ? v1.version : -1,
            'default'
        )
        expect(v2.result).toBe('success')

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('persistent-thread')
        expect(metadata?.name).toBe('renamed')
        expect(metadata?.tools).toEqual(['read_file'])
    })

    itPg('returns version-mismatch unchanged when the expected version is stale', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-version-mismatch',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            { path: '/tmp/project', host: 'example' },
            session.metadataVersion + 99,
            'default'
        )
        expect(result.result).toBe('version-mismatch')
        if (result.result === 'version-mismatch') {
            const value = result.value as Record<string, unknown> | null
            expect(value?.cursorSessionId).toBe('stable-id')
        }
    })

    itPg('returns error when the session row does not exist', async () => {
        const store = await makeStore()
        const result = await store.updateSessionMetadata(
            'no-such-session',
            { path: '/tmp/project', host: 'example' },
            0,
            'default'
        )
        expect(result.result).toBe('error')
    })

    itPg('archive then read-back ships a payload that legacy resume routing can use', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-roundtrip',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'legacy-uuid',
                lifecycleState: 'running'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed',
                archivedBy: 'cli'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id)
        expect(metadata?.cursorSessionId).toBe('legacy-uuid')
        expect(metadata?.flavor).toBe('cursor')
    })

    itPg('preserves required path and host when archive payload is sparse (sparse-cache failure mode)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-sparse-archive',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'parse-required'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.path).toBe('/tmp/project')
        expect(metadata?.host).toBe('example')
        expect(metadata?.cursorSessionId).toBe('parse-required')
        expect(metadata?.lifecycleState).toBe('archived')
    })

    itPg('does not invent path or host when prior had none', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'no-prior-identity',
            { flavor: 'cursor' },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            { lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.lifecycleState).toBe('archived')
        expect('path' in (metadata ?? {})).toBe(false)
        expect('host' in (metadata ?? {})).toBe(false)
    })

    itPg('preserves flavor and machineId across sparse archive (resume routing)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-routing-survives',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                machineId: 'mach-xyz',
                cursorSessionId: 'cursor-thread-routed'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.flavor).toBe('cursor')
        expect(metadata?.machineId).toBe('mach-xyz')
        expect(metadata?.cursorSessionId).toBe('cursor-thread-routed')
    })

    itPg('does not invent flavor or machineId when prior had none', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'no-prior-routing',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            { lifecycleState: 'archived' },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.lifecycleState).toBe('archived')
        expect('flavor' in (metadata ?? {})).toBe(false)
        expect('machineId' in (metadata ?? {})).toBe(false)
    })

    itPg('lets the next write override flavor and machineId when explicitly set', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'override-routing',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                machineId: 'mach-old'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                machineId: 'mach-new'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.flavor).toBe('codex')
        expect(metadata?.machineId).toBe('mach-new')
    })

    itPg('drops cursorSessionProtocol when a new cursorSessionId is written', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-protocol-pair-drop',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'old-id',
                cursorSessionProtocol: 'acp'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'new-id'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('new-id')
        expect(metadata?.cursorSessionProtocol).toBeUndefined()
    })

    itPg('preserves cursorSessionProtocol when neither id nor protocol is in the next write', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-protocol-pair-preserve',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id',
                cursorSessionProtocol: 'acp'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                lifecycleState: 'archived',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('stable-id')
        expect(metadata?.cursorSessionProtocol).toBe('acp')
    })

    itPg('respects an explicit cursorSessionProtocol on the next write even when the id is unchanged', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-protocol-pair-explicit',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'stable-id'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionProtocol: 'stream-json'
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata?.cursorSessionId).toBe('stable-id')
        expect(metadata?.cursorSessionProtocol).toBe('stream-json')
    })

    itPg('returns the merged value in the success ack, not the pre-merge input', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'cursor-ack-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'should-survive-ack'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'Session crashed'
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        if (result.result === 'success') {
            const value = result.value as Record<string, unknown> | null
            expect(value?.path).toBe('/tmp/project')
            expect(value?.host).toBe('example')
            expect(value?.cursorSessionId).toBe('should-survive-ack')
            expect(value?.lifecycleState).toBe('archived')
        }
    })

    itPg('drops a carry-forward field when next sets it to null (explicit clear)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'codex-explicit-clear',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: 'old-thread'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'codex',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect(metadata).not.toBeNull()
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
        expect(metadata?.flavor).toBe('codex')
    })

    itPg('treats null as clear for any carry-forward field, independently of others', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'multi-token-explicit-clear',
            {
                path: '/tmp/project',
                host: 'example',
                flavor: 'cursor',
                cursorSessionId: 'cursor-keep',
                codexSessionId: 'codex-clear-me'
            },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
        expect(metadata?.cursorSessionId).toBe('cursor-keep')
        expect(metadata?.flavor).toBe('cursor')
    })

    itPg('null on a never-set field is a no-op (does not introduce the key)', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'null-on-absent',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )

        await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        const metadata = await getMetadata(store, session.id) as Record<string, unknown> | null
        expect('codexSessionId' in (metadata ?? {})).toBe(false)
    })

    itPg('explicit clear leaves the merged value in the success ack', async () => {
        const store = await makeStore()
        const session = await store.getOrCreateSession(
            'explicit-clear-ack',
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: 'thread-x'
            },
            null,
            'default'
        )

        const result = await store.updateSessionMetadata(
            session.id,
            {
                path: '/tmp/project',
                host: 'example',
                codexSessionId: null
            },
            session.metadataVersion,
            'default'
        )

        expect(result.result).toBe('success')
        if (result.result === 'success') {
            const value = result.value as Record<string, unknown> | null
            expect('codexSessionId' in (value ?? {})).toBe(false)
            expect(value?.path).toBe('/tmp/project')
        }
    })
})
