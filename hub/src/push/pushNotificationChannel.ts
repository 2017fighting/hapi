import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, PlannotatorOpenedInfo, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string
    ) {}

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const normalizedStatus = notification.status?.trim().toLowerCase()
        const isFailure = normalizedStatus === 'failed'
            || normalizedStatus === 'error'
            || normalizedStatus === 'killed'
            || normalizedStatus === 'aborted'

        const payload: PushPayload = {
            title: isFailure ? 'Task failed' : 'Task completed',
            body: `${agentName} · ${name} · ${notification.summary}`,
            data: {
                type: 'task-notification',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }

    async sendPlannotatorOpened(info: PlannotatorOpenedInfo): Promise<void> {
        const label = info.label?.trim() || (
            info.mode === 'review' ? 'Code review'
                : info.mode === 'annotate' ? 'Annotate'
                    : 'plannotator'
        )
        const title = 'Plannotator opened'

        // In-app toast (click navigates to the plannotator SPA route) when a web
        // client for this namespace is visible; otherwise fall back to web-push,
        // whose notification action opens the absolute URL. Mirrors sendPermissionRequest.
        if (this.visibilityTracker.hasVisibleConnection(info.namespace)) {
            const delivered = await this.sseManager.sendToast(info.namespace, {
                type: 'toast',
                data: {
                    title,
                    body: label,
                    url: info.path
                }
            })
            if (delivered > 0) {
                return
            }
        }

        const payload: PushPayload = {
            title,
            body: label,
            tag: `plannotator-${info.path}`,
            data: {
                type: 'plannotator-opened',
                sessionId: '',
                url: info.url
            }
        }
        await this.pushService.sendToNamespace(info.namespace, payload)
    }
}
