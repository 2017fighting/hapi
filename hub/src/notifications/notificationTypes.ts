import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'

export type TaskNotification = {
    summary: string
    status?: string
}

/**
 * A plannotator self-started session (code review / annotate) just opened at a
 * public hub URL. `path` is the in-app SPA route (`/plannotator/<token>`) used by
 * the web toast's click-to-navigate; `url` is the absolute URL for web-push /
 * Telegram. See adr/0001-plannotator-tunnel.md (Phase 5 #6).
 */
export type PlannotatorOpenedInfo = {
    namespace: string
    mode?: string
    label?: string
    path: string
    url: string
}

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
    /** Surface a freshly-opened plannotator session (toast-if-visible / push / Telegram). */
    sendPlannotatorOpened?: (info: PlannotatorOpenedInfo) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
