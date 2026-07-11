import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { createTestStore } from '../../store/testStore'
import type { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createCodexDesktopRoutes, importSelectedCodexSessions } from './codexDesktop'

const TEST_URL = process.env.TEST_DATABASE_URL
const itPg = TEST_URL ? it : it.skip

const originalCodexHome = process.env.CODEX_HOME

function createTranscript(codexHome: string, sessionId: string, cwd = 'C:\\work\\project'): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    const lines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd,
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'normal user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'normal assistant message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createMachine(id: string, workspaceRoots: string[], namespace = 'default'): Machine {
    return {
        id,
        namespace,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: id,
            platform: 'linux',
            happyCliVersion: '0.0.0-test',
            workspaceRoots
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1
    }
}

function createImportSyncEngine(store: Store, machines: Machine[]): SyncEngine {
    return {
        getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => (
            machine.namespace === namespace && machine.active
        )),
        getSessionsByNamespace: async (namespace: string) => (
            await store.sessions.getSessionsByNamespace(namespace)
        ),
        getOrCreateSession: async (
            tag: string,
            metadata: unknown,
            agentState: unknown,
            namespace: string
        ) => (
            await store.sessions.getOrCreateSession(tag, metadata, agentState, namespace)
        ),
        handleRealtimeEvent: async () => {},
        recordSessionActivity: async (sessionId: string, updatedAt: number) => {
            await store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
        }
    } as unknown as SyncEngine
}

async function createRoutesApp(namespace: string): Promise<Hono<WebAppEnv>> {
    const store = await createTestStore()
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createCodexDesktopRoutes({
        store,
        getSyncEngine: () => null
    }))
    return app
}

describe('Codex Desktop import routes', () => {
    afterEach(() => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
    })

    itPg('imports normal response_item chat messages', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-test-'))
        const store = await createTestStore()
        const codexSessionId = '11111111-1111-4111-8111-111111111111'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            const session = (await store.sessions.getSessionsByNamespace('default'))[0]
            expect(session).toBeDefined()
            const messages = await store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(2)
            expect(messages[0].content).toEqual({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'normal user message'
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
            expect(messages[1].content).toEqual({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'normal assistant message',
                        id: expect.any(String)
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    itPg('binds imported transcripts to the unique online machine that owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-test-'))
        const store = await createTestStore()
        const codexSessionId = '22222222-2222-4222-8222-222222222222'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/other/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = (await store.sessions.getSessionsByNamespace('default'))[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-1'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    itPg('does not bind imported transcripts when multiple online machines own the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-ambiguous-test-'))
        const store = await createTestStore()
        const codexSessionId = '33333333-3333-4333-8333-333333333333'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/home/user/workspace/project'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = (await store.sessions.getSessionsByNamespace('default'))[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    itPg('does not bind imported transcripts when no online machine owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-miss-test-'))
        const store = await createTestStore()
        const codexSessionId = '44444444-4444-4444-8444-444444444444'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/other'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = (await store.sessions.getSessionsByNamespace('default'))[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    itPg('keeps an existing machineId when updating an imported transcript', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-existing-test-'))
        const store = await createTestStore()
        const codexSessionId = '55555555-5555-4555-8555-555555555555'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            await store.sessions.getOrCreateSession(randomUUID(), {
                path: '/home/user/workspace/project',
                flavor: 'codex',
                codexSessionId,
                machineId: 'machine-existing'
            }, {}, 'default')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-new', ['/home/user/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = (await store.sessions.getSessionsByNamespace('default'))[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-existing'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    itPg('rejects Codex transcript endpoints outside the default namespace', async () => {
        const app = await createRoutesApp('team-a')
        const response = await app.request('/api/codex/sessions')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Codex transcript import is not available outside the default namespace'
        })
    })

    itPg('allows Codex transcript endpoints in the default namespace', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-route-test-'))
        process.env.CODEX_HOME = codexHome

        try {
            const app = await createRoutesApp('default')
            const response = await app.request('/api/codex/sessions')

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                success: true,
                sessions: []
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})
