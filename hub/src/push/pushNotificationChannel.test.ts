import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-task-toast',
        namespace: 'default',
        name: 'Demo task',
        active: true,
        metadata: { flavor: 'codex' },
        ...overrides
    } as Session
}

describe('PushNotificationChannel', () => {
    it('sends task notifications to visible web clients before falling back to push', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: unknown[] = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 1
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Background work finished'
        })

        expect(toasts).toHaveLength(1)
        expect(pushed).toHaveLength(0)
    })

    it('does not reuse one replacement tag for all task notifications in a session', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'First task'
        })
        await channel.sendTaskNotification(createSession(), {
            status: 'failed',
            summary: 'Second task'
        })

        expect(pushed).toHaveLength(2)
        expect(pushed[0].payload.tag).toBeUndefined()
        expect(pushed[1].payload.tag).toBeUndefined()
    })

    it('sendPlannotatorOpened: toasts with the in-app path when a web client is visible', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: Array<{ namespace: string; event: unknown }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async (namespace: string, event: unknown) => {
                    toasts.push({ namespace, event })
                    return 1
                }
            } as never,
            { hasVisibleConnection: () => true } as never,
            ''
        )

        await channel.sendPlannotatorOpened({
            namespace: 'ns-1',
            mode: 'review',
            label: 'code review',
            path: '/plannotator/abc',
            url: 'https://hub.example/plannotator/abc'
        })

        expect(toasts).toHaveLength(1)
        expect(toasts[0]).toEqual({
            namespace: 'ns-1',
            event: {
                type: 'toast',
                data: { title: 'Plannotator opened', body: 'code review', url: '/plannotator/abc' }
            }
        })
        expect(pushed).toHaveLength(0)
    })

    it('sendPlannotatorOpened: falls back to web-push with the absolute URL when no visible client', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            { sendToast: async () => 0 } as never,
            { hasVisibleConnection: () => false } as never,
            ''
        )

        await channel.sendPlannotatorOpened({
            namespace: 'ns-1',
            mode: 'annotate',
            path: '/plannotator/abc',
            url: 'https://hub.example/plannotator/abc'
        })

        expect(pushed).toHaveLength(1)
        expect(pushed[0].namespace).toBe('ns-1')
        expect(pushed[0].payload).toEqual({
            title: 'Plannotator opened',
            body: 'Annotate',
            tag: 'plannotator-/plannotator/abc',
            data: { type: 'plannotator-opened', sessionId: '', url: 'https://hub.example/plannotator/abc' }
        })
    })
})
