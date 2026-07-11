/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in PostgreSQL
 */

import { isKnownFlavor, type LocalResumeTarget, type ResumableSession } from '@hapi/protocol'
import type { CursorMigrateOutcome, CursorMigrateToAcpRequest, SlashCommandsResponse } from '@hapi/protocol/apiTypes'
import type { AgentFlavor, CodexCollaborationMode, DecryptedMessage, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Server } from 'socket.io'
import type { Store, CancelQueuedMessageResult } from '../store'
import type { HapiSessionExportResult } from '@hapi/protocol/sessionExport'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'

import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import {
    RpcGateway,
    RpcTargetMissingError,
    type RpcCodexModel,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcGeneratedImageResponse,
    type RpcListDirectoryResponse,
    type RpcListCodexModelsResponse,
    type RpcListCursorModelsResponse,
    type RpcListOpencodeModelsResponse,
    type RpcListOpencodeReasoningEffortOptionsResponse,
    type RpcCursorModel,
    type RpcOpencodeModel,
    type RpcPathExistsResponse,
    type RpcReadFileResponse,
    type RpcUploadFileResponse
} from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCodexModel,
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcGeneratedImageResponse,
    RpcListDirectoryResponse,
    RpcListCodexModelsResponse,
    RpcListCursorModelsResponse,
    RpcListOpencodeModelsResponse,
    RpcListOpencodeReasoningEffortOptionsResponse,
    RpcCursorModel,
    RpcOpencodeModel,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export type ReopenSessionResult =
    | { type: 'success'; sessionId: string; resumed: boolean; cursorSessionProtocol?: 'acp' | 'stream-json' }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' | 'metadata_conflict' }
    | { type: 'incomplete'; message: string; missing: [string, ...string[]] }

export type LocalResumeTargetResult =
    | { type: 'success'; target: LocalResumeTarget }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'resume_unavailable' }

export type LocalHandoffResult =
    | { type: 'success' }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'already_local' | 'handoff_failed' }

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function normalizeUserMessageText(value: string): string | undefined {
    const text = value.trim().replace(/\s+/g, ' ')
    return text.length > 0 ? text : undefined
}

function extractUserMessageText(content: unknown): string | undefined {
    if (typeof content === 'string') {
        return normalizeUserMessageText(content)
    }

    if (Array.isArray(content)) {
        const parts = content
            .map((block) => {
                const record = asRecord(block)
                return record?.type === 'text' && typeof record.text === 'string'
                    ? record.text
                    : null
            })
            .filter((text): text is string => text !== null)
        return normalizeUserMessageText(parts.join(' '))
    }

    const record = asRecord(content)
    if (record?.type === 'text' && typeof record.text === 'string') {
        return normalizeUserMessageText(record.text)
    }

    return undefined
}

function extractClaudeUserMessageTextFromAgentOutput(content: unknown): string | undefined {
    const record = asRecord(content)
    if (record?.type !== 'output') return undefined

    const data = asRecord(record.data)
    if (data?.type !== 'user') return undefined

    const message = asRecord(data.message)
    if (message?.role !== 'user') return undefined

    return extractUserMessageText(message.content)
}

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null
    /** Sessions that emitted `session-ready` (Cursor ACP load/newSession complete). */
    private readonly sessionReadyIds = new Set<string>()

    constructor(
        private readonly store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager
    ) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(
            store,
            io,
            this.eventPublisher,
            (sessionId, updatedAt) => this.recordSessionActivity(sessionId, updatedAt)
        )
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        void this.reloadAll()
        this.inactivityTimer = setInterval(() => void this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.sessionCache.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    async getFutureScheduledMessageCounts(sessionIds: string[], now: number = Date.now()): Promise<Map<string, number>> {
        return await this.store.messages.countFutureScheduledBySessionIds(sessionIds, now)
    }

    async getNextScheduledAtBySessionIds(sessionIds: string[], now: number = Date.now()): Promise<Map<string, number>> {
        return await this.store.messages.minFutureScheduledAtBySessionIds(sessionIds, now)
    }

    async getSession(sessionId: string): Promise<Session | undefined> {
        return this.sessionCache.getSession(sessionId) ?? await this.sessionCache.refreshSession(sessionId) ?? undefined
    }

    async getSessionByNamespace(sessionId: string, namespace: string): Promise<Session | undefined> {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? await this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    async resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): Promise<{ ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' }> {
        return await this.sessionCache.resolveSessionAccess(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
    }

    async getMessagesPage(
        sessionId: string,
        options: { limit: number; before?: { at: number; seq: number } | null }
    ): Promise<{
        messages: DecryptedMessage[]
        page: {
            limit: number
            nextBeforeSeq: number | null
            nextBeforeAt: number | null
            hasMore: boolean
        }
    }> {
        return await this.messageService.getMessagesPage(sessionId, options)
    }

    async getSessionExport(sessionId: string, session: Session): Promise<HapiSessionExportResult> {
        return await this.messageService.getSessionExport(sessionId, session)
    }

    async getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): Promise<DecryptedMessage[]> {
        return await this.messageService.getDeliverableMessagesAfter(sessionId, options)
    }

    async handleRealtimeEvent(event: SyncEvent): Promise<void> {
        if (event.type === 'session-updated' && event.sessionId) {
            // Snapshot agent session IDs before refresh — safe because JS is single-threaded
            // and refreshSession replaces the Map entry with a new object.
            const before = this.sessionCache.getSession(event.sessionId)
            await this.sessionCache.refreshSession(event.sessionId)
            const after = this.sessionCache.getSession(event.sessionId)
            if (after?.metadata && !this.hasSameAgentSessionIds(before?.metadata ?? null, after.metadata)) {
                if (!this.canRunCursorDedup(after)) {
                    return
                }
                void this.sessionCache.deduplicateByAgentSessionId(event.sessionId).catch(() => {
                    // best-effort: dedup failure is harmless, web-side safety net hides remaining duplicates
                })
            }
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            await this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.sessionCache.getSession(event.sessionId)) {
                await this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    async handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        effort?: string | null
        serviceTier?: string | null
        collaborationMode?: CodexCollaborationMode
    }): Promise<void> {
        await this.sessionCache.handleSessionAlive(payload)
        this.triggerDedupIfNeeded(payload.sid)
    }

    handleSessionReady(payload: { sid: string; time: number }): void {
        this.sessionReadyIds.add(payload.sid)
        this.triggerDedupIfNeeded(payload.sid)
    }

    clearQueuedThinkingGrace(sessionId: string): void {
        this.sessionCache.clearQueuedThinkingGrace(sessionId)
    }

    async handleSessionEnd(payload: { sid: string; time: number; reason?: 'completed' | 'terminated' | 'error' }): Promise<void> {
        const before = this.sessionCache.getSession(payload.sid)
        const isCursorAcp = before?.metadata?.flavor === 'cursor'
            && before.metadata.cursorSessionProtocol === 'acp'
        const shouldRetryDedup = !isCursorAcp || this.sessionReadyIds.has(payload.sid)

        await this.sessionCache.handleSessionEnd(payload)
        this.eventPublisher.emit({
            type: 'session-ended',
            sessionId: payload.sid,
            reason: payload.reason
        })
        // Retry dedup now that this session is inactive — a prior dedup may have
        // skipped it because it was still active at the time. Cursor ACP rows that
        // never reached session-ready must not dedup-merge the original on failure.
        if (shouldRetryDedup) {
            this.triggerDedupIfNeeded(payload.sid)
        }
        this.sessionReadyIds.delete(payload.sid)
    }

    handleBackgroundTaskDelta(sessionId: string, delta: { started: number; completed: number }): void {
        this.sessionCache.applyBackgroundTaskDelta(sessionId, delta)
    }

    async recordSessionActivity(sessionId: string, updatedAt: number): Promise<void> {
        await this.sessionCache.recordSessionActivity(sessionId, updatedAt)
    }

    async handleMachineAlive(payload: { machineId: string; time: number; health?: unknown }): Promise<void> {
        await this.machineCache.handleMachineAlive(payload)
    }

    private async expireInactive(): Promise<void> {
        const expired = this.sessionCache.expireInactive()
        // Sort by most recent first so dedup keeps the newest session when multiple
        // duplicates for the same agent thread expire in the same sweep.
        const sorted = expired
            .map((id) => this.sessionCache.getSession(id))
            .filter((s): s is NonNullable<typeof s> => s != null)
            .sort((a, b) => (b.activeAt - a.activeAt) || (b.updatedAt - a.updatedAt))
        for (const session of sorted) {
            this.triggerDedupIfNeeded(session.id)
        }
        this.machineCache.expireInactive()
        // Piggybacked on the inactivity tick; not a logical part of expireInactive
        // but shares its 5s cadence (avoids a second timer).
        await this.messageService.releaseMatureScheduledMessages(Date.now())
    }

    private async reloadAll(): Promise<void> {
        await this.sessionCache.reloadAll()
        await this.machineCache.reloadAll()
    }

    async getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string
    ): Promise<Session> {
        return await this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace, model, effort, modelReasoningEffort)
    }

    async getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Promise<Machine> {
        return await this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp'
            scheduledAt?: number | null
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
        await this.sessionCache.markMessageQueued(sessionId)
        await this.sessionCache.recordSessionActivity(sessionId, Date.now())
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        return this.messageService.cancelQueuedMessage(sessionId, messageId)
    }

    async sweepImmediateQueuedOnSessionEnd(sessionId: string, invokedAt: number): Promise<{ localIds: string[]; invokedAt: number } | null> {
        return await this.messageService.sweepImmediateQueuedOnSessionEnd(sessionId, invokedAt)
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        // tiann/hapi#916: when the CLI is already gone (e.g. after a
        // hub-restart cascade SIGTERMed the runner but the in-memory
        // `active` flag has not been reconciled yet) the kill-RPC throws
        // and the route used to surface that as HTTP 500. Treat the
        // missing target as a benign condition: still flip the session's
        // lifecycleState to `archived` in the hub-side metadata so the
        // UI does not see a half-cleaned zombie, and continue to mark
        // it inactive in the cache. Real RPC errors (timeout, protocol
        // failure) still propagate as 5xx.
        try {
            await this.rpcGateway.killSession(sessionId)
        } catch (error) {
            if (error instanceof RpcTargetMissingError) {
                await this.sessionCache.markSessionArchivedFromHub(sessionId, 'Archived from hub (CLI unreachable)')
            } else {
                throw error
            }
        }
        await this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    /**
     * Apply the post-migration metadata flip in hapi.db:
     *   - metadata.cursorSessionProtocol = 'acp'
     *   - session.model = lastUsedModel (if provided)
     *
     * Returns 'success' on a clean write, 'version-mismatch' if the metadata
     * version moved underneath us (caller retries) or 'not-found' if the row
     * is gone.
     */
    async flipCursorSessionProtocolToAcp(
        sessionId: string,
        namespace: string,
        lastUsedModel: string | null
    ): Promise<{ result: 'success' | 'version-mismatch' | 'not-found' | 'session-active' }> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? await this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) {
                return { result: 'not-found' }
            }
            // Combined SSE-event payload contract (UX A++): clear the
            // `cursorMigrationState='in_progress'` flag in the SAME metadata
            // write that flips `cursorSessionProtocol` to 'acp'. The web
            // banner keys off `cursorMigrationState`, so a single SSE
            // session-updated event swaps both atomically — banner gone,
            // protocol flipped — preventing a flicker window where the
            // banner has already disappeared but the chat hasn't re-rendered
            // to the ACP transport yet.
            const carriedMigrationState = latest.metadata.cursorMigrationState
            // Atomic active-check inside the same synchronous flip op so
            // that a resume cannot land between the migrator's recheck
            // and the actual DB update. Bun is single-threaded — once
            // we've read `latest` and the row is inactive, no other JS
            // can mutate active=true until this method returns. Codex
            // review #34 P1 v2: the migrator's recheck is best-effort;
            // this is the authoritative gate.
            //
            // Codex review #34 P2 v5: only block on `active === true`,
            // NOT on lifecycleState === 'running'. After a force-archive
            // flow archiveSession() synchronously sets active=false but
            // the cleanup metadata write that flips lifecycleState
            // 'running' → 'archived' may still be in-flight, and that
            // is OUR archive completing, not a resume race. The active
            // flag is the authoritative live-runner signal.
            if (latest.active === true) {
                return { result: 'session-active' }
            }
            // Codex review #34 P2 v7: ALSO clear a stale lifecycleState
            // value if it still says 'running'. The migrator now skips
            // archiveSession() for stale-running rows (active=false but
            // lifecycle=running with --force-archive-running) because
            // there's no live runner to archive. Without this fixup,
            // successfully migrated stale rows would retain lifecycle=
            // running forever and any downstream code that filters by
            // lifecycleState (not the cache active flag) would keep
            // treating archived ACP sessions as live.
            const oldLifecycle = typeof latest.metadata.lifecycleState === 'string' ? latest.metadata.lifecycleState : undefined
            const nextMetadata: typeof latest.metadata = {
                ...latest.metadata,
                cursorSessionProtocol: 'acp' as const,
                ...(oldLifecycle === 'running' ? { lifecycleState: 'archived' as const } : {})
            }
            // Drop the migration-in-progress flag in the same write (see
            // header comment). Safe whether or not it was set.
            if (carriedMigrationState !== undefined) {
                delete nextMetadata.cursorMigrationState
            }
            const result = await this.store.sessions.updateSessionMetadata(
                sessionId,
                nextMetadata,
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'version-mismatch') {
                await this.sessionCache.refreshSession(sessionId)
                continue
            }
            if (result.result !== 'success') {
                return { result: 'not-found' }
            }
            await this.sessionCache.refreshSession(sessionId)
            if (lastUsedModel && lastUsedModel.trim().length > 0) {
                await this.store.sessions.setSessionModel(sessionId, lastUsedModel.trim(), namespace, { touchUpdatedAt: false })
                await this.sessionCache.refreshSession(sessionId)
            }
            return { result: 'success' }
        }
        return { result: 'version-mismatch' }
    }

    /**
     * Migrate a single legacy cursor session to ACP. Hub-side; runs on the
     * operator's machine (the hub host); see tiann/hapi#824 design.
     * Returns a structured outcome (ok or refusal); does not throw.
     *
     * Legacy pre-V8 SQLite migration is obsolete on the PostgreSQL backend —
     * there is no on-disk hapi.db to transplant. Existing users run the P5
     * sqlite→postgres script instead. The endpoint is kept so the web client
     * gets a clean 404 (`no_legacy_store_on_disk`) rather than a route 404.
     */
    async migrateLegacyCursorSession(
        sessionId: string,
        _namespace: string,
        _request: CursorMigrateToAcpRequest
    ): Promise<CursorMigrateOutcome> {
        return {
            ok: false,
            sessionId,
            reason: 'no_legacy_store_on_disk',
            message: 'Legacy SQLite migration is not available on the PostgreSQL backend.',
            durationMs: 0
        }
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            serviceTier?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<void> {
        const session = this.sessionCache.getSession(sessionId)
        if (!session?.active) {
            // For inactive sessions, update the in-memory cache directly without
            // an RPC call — the CLI is not running yet. The updated value will be
            // passed to the spawned process when the session is resumed.
            await this.sessionCache.applySessionConfig(sessionId, config)
            return
        }

        const result = await this.rpcGateway.requestSessionConfig(sessionId, config) as Record<string, unknown>
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as {
            error?: string
            applied?: {
                permissionMode?: Session['permissionMode']
                model?: Session['model']
                modelReasoningEffort?: Session['modelReasoningEffort']
                effort?: Session['effort']
                serviceTier?: Session['serviceTier']
                collaborationMode?: Session['collaborationMode']
            }
        }
        if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
            throw new Error(obj.error)
        }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error(`Missing applied session config, got: ${JSON.stringify(result)}`)
        }

        const requestedKeys = Object.keys(config) as Array<keyof typeof config>
        for (const key of requestedKeys) {
            if (!(key in applied)) {
                throw new Error(`Session did not apply ${key}`)
            }
        }

        await this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: AgentFlavor = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(
            machineId,
            directory,
            agent,
            model,
            modelReasoningEffort,
            yolo,
            sessionType,
            worktreeName,
            resumeSessionId,
            effort,
            permissionMode,
            serviceTier
        )
    }

    private resolveFlavor(session: Session): AgentFlavor {
        const flavor = session.metadata?.flavor
        return isKnownFlavor(flavor) ? flavor : 'claude'
    }

    private async resolveAgentResumeId(session: Session, namespace: string): Promise<string | null> {
        const metadata = session.metadata
        if (!metadata) {
            return null
        }

        const flavor = this.resolveFlavor(session)
        if (flavor === 'codex') return metadata.codexSessionId ?? null
        if (flavor === 'gemini') return metadata.geminiSessionId ?? null
        if (flavor === 'opencode') return metadata.opencodeSessionId ?? null
        if (flavor === 'cursor') return metadata.cursorSessionId ?? null
        if (flavor === 'kimi') return metadata.kimiSessionId ?? null
        if (flavor === 'pi') return metadata.piSessionId ?? null

        return metadata.claudeSessionId ?? await this.recoverClaudeSessionIdFromMessages(session.id, namespace)
    }

    async resolveLocalResumeTarget(sessionId: string, namespace: string): Promise<LocalResumeTargetResult> {
        const access = await this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const agentSessionId = await this.resolveAgentResumeId(session, namespace)
        if (!agentSessionId) {
            return {
                type: 'error',
                message: 'Resume session ID unavailable. Start a new session in this directory, or retry after the agent has initialized.',
                code: 'resume_unavailable'
            }
        }

        return {
            type: 'success',
            target: {
                sessionId: access.sessionId,
                flavor: this.resolveFlavor(session),
                directory: metadata.path,
                machineId: metadata.machineId,
                host: metadata.host,
                active: session.active,
                thinking: session.thinking,
                controlledByUser: session.agentState?.controlledByUser === true,
                agentSessionId,
                model: session.model ?? null,
                effort: session.effort ?? null,
                modelReasoningEffort: session.modelReasoningEffort ?? null,
                permissionMode: session.permissionMode,
                collaborationMode: session.collaborationMode
            }
        }
    }

    async listLocalResumableSessions(namespace: string, opts?: { machineId?: string }): Promise<ResumableSession[]> {
        const sessions = this.getSessionsByNamespace(namespace)
        const results: ResumableSession[] = []
        for (const session of sessions) {
            const targetResult = await this.resolveLocalResumeTarget(session.id, namespace)
            if (targetResult.type !== 'success') continue
            const { target } = targetResult
            const sessionRow = await this.getSessionByNamespace(target.sessionId, namespace)
            results.push({
                sessionId: target.sessionId,
                flavor: target.flavor,
                directory: target.directory,
                machineId: target.machineId,
                host: target.host,
                active: target.active,
                thinking: target.thinking,
                controlledByUser: target.controlledByUser,
                agentSessionId: target.agentSessionId,
                model: target.model,
                effort: target.effort,
                modelReasoningEffort: target.modelReasoningEffort,
                permissionMode: target.permissionMode,
                collaborationMode: target.collaborationMode,
                updatedAt: sessionRow?.updatedAt ?? 0,
                name: sessionRow?.metadata?.name,
                summary: sessionRow?.metadata?.summary?.text,
                firstUserMessage: await this.resolveFirstUserMessage(target.sessionId)
            })
        }
        return results
            .filter((session) => !opts?.machineId || session.machineId === opts.machineId)
            .sort((a, b) => b.updatedAt - a.updatedAt)
    }

    private async resolveFirstUserMessage(sessionId: string): Promise<string | undefined> {
        for (const message of await this.store.messages.getFirstMessages(sessionId, 50)) {
            const roleWrapped = unwrapRoleWrappedRecordEnvelope(message.content)
            const text = roleWrapped?.role === 'user'
                ? extractUserMessageText(roleWrapped.content)
                : roleWrapped?.role === 'agent'
                    ? extractClaudeUserMessageTextFromAgentOutput(roleWrapped.content)
                    : undefined
            if (text) return text
        }

        return undefined
    }

    /** Inactive session with directory path but no agent thread and no prior user turn. */
    private async canFreshSpawnNeverStartedSession(session: Session, sessionId: string, namespace: string): Promise<boolean> {
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string' || metadata.path.length === 0) {
            return false
        }
        if (await this.resolveAgentResumeId(session, namespace)) {
            return false
        }
        return (await this.store.messages.getFirstMessages(sessionId, 1)).length === 0
    }

    async resumeSession(sessionId: string, namespace: string, opts?: { permissionMode?: PermissionMode }): Promise<ResumeSessionResult> {
        const access = await this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const initialSession = access.session
        if (initialSession.active) {
            return { type: 'success', sessionId: access.sessionId }
        }

        const session = initialSession

        const targetResult = await this.resolveLocalResumeTarget(access.sessionId, namespace)
        let flavor: AgentFlavor
        let resumeToken: string | undefined
        let directory: string

        if (targetResult.type === 'success') {
            flavor = targetResult.target.flavor
            resumeToken = targetResult.target.agentSessionId
            directory = targetResult.target.directory
        } else if (
            targetResult.code === 'resume_unavailable'
            && await this.canFreshSpawnNeverStartedSession(session, access.sessionId, namespace)
        ) {
            const metadata = session.metadata!
            flavor = this.resolveFlavor(session)
            resumeToken = undefined
            directory = metadata.path
        } else {
            return targetResult
        }

        const metadata = session.metadata!

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = (() => {
            if (metadata.machineId) {
                const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                if (exact) return exact
            }
            if (metadata.host) {
                const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                if (hostMatch) return hostMatch
            }
            return null
        })()

        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const preferredPermissionMode = opts?.permissionMode
            ?? session.permissionMode
            ?? session.metadata?.preferredPermissionMode
        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            directory,
            flavor,
            session.model ?? undefined,
            session.modelReasoningEffort ?? undefined,
            undefined,
            undefined,
            undefined,
            resumeToken,
            session.effort ?? undefined,
            preferredPermissionMode,
            session.serviceTier ?? undefined
        )

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        }

        // permissionMode is passed to spawnSession above; do not call set-session-config here.
        // session-alive can arrive before the CLI registers that RPC handler, which caused resume_failed.

        const needsReadyBeforeMerge = spawnResult.sessionId !== access.sessionId
            && flavor === 'cursor'
            && metadata.cursorSessionProtocol === 'acp'
        if (needsReadyBeforeMerge) {
            const readyResult = await this.waitForSessionReady(spawnResult.sessionId)
            if (readyResult !== 'ready') {
                const message = readyResult === 'ended'
                    ? 'Session ended before Cursor ACP load completed'
                    : 'Session failed to become ready'
                return { type: 'error', message, code: 'resume_failed' }
            }
        }

        if (spawnResult.sessionId !== access.sessionId) {
            // The old session may have already been merged by the automatic dedup path
            // (triggered when the spawned CLI sets its agent session ID in metadata).
            // Only attempt the explicit merge if the old session still exists.
            const oldSession = this.sessionCache.getSessionByNamespace(access.sessionId, namespace)
            if (oldSession) {
                try {
                    await this.sessionCache.mergeSessions(access.sessionId, spawnResult.sessionId, namespace)
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Failed to merge resumed session'
                    return { type: 'error', message, code: 'resume_failed' }
                }
            }
        }

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    /**
     * Revive an archived session so the web UI can reach it again.
     *
     * Behaviour:
     * - Active session: idempotent no-op (`resumed: false`).
     * - Non-archived inactive session: forwards to `resumeSession` without touching metadata.
     * - Archived session: validates that the agent has enough metadata to resume (Cursor
     *   sessions require a `cursorSessionId` once they have any messages), clears the
     *   archive metadata (`lifecycleState`, `archivedBy`, `archiveReason`), defaults the
     *   Cursor protocol to `stream-json` for pre-#799 sessions, then forwards to
     *   `resumeSession`. The CLI's `sessionFactory` will re-stamp `lifecycleState='running'`
     *   when it boots, so we do not pre-write that here.
     *
     * Failure rollback: if `resumeSession` fails (no machine online, spawn timeout, etc.)
     * the archive snapshot is restored so the operator can retry without losing
     * `archiveReason`/`archivedBy`/`lifecycleState` and the UI still shows the row as
     * archived rather than a dangling inactive non-archived ghost.
     *
     * Returns `incomplete` (HTTP 422 from the route layer) when the agent metadata
     * needed to resume is missing.
     */
    async reopenSession(sessionId: string, namespace: string): Promise<ReopenSessionResult> {
        const access = await this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        const metadata = session.metadata

        if (session.active) {
            return { type: 'success', sessionId: access.sessionId, resumed: false }
        }

        const isArchived = metadata?.lifecycleState === 'archived'

        if (isArchived && metadata) {
            if (metadata.flavor === 'cursor' && !metadata.cursorSessionId) {
                const hasMessages = (await this.store.messages.getFirstMessages(access.sessionId, 1)).length > 0
                if (hasMessages) {
                    return {
                        type: 'incomplete',
                        message: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                        missing: ['cursorSessionId']
                    }
                }
            }

            const archiveSnapshot = {
                lifecycleState: metadata.lifecycleState,
                archivedBy: metadata.archivedBy,
                archiveReason: metadata.archiveReason,
                lifecycleStateSince: metadata.lifecycleStateSince
            }

            let applied: { cursorSessionProtocol?: 'acp' | 'stream-json' }
            try {
                applied = await this.sessionCache.clearSessionArchiveMetadata(access.sessionId)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to clear archive metadata'
                return { type: 'error', message, code: 'metadata_conflict' }
            }

            const resumeResult = await this.resumeSession(access.sessionId, namespace)
            if (resumeResult.type === 'error') {
                // Resume failed - put the archive flags back so the row stays archived in the UI
                // and the operator can retry. Best-effort: a concurrent metadata write that
                // succeeded between clear and restore (e.g. an unrelated rename) wins, in
                // which case we surface the original resume error rather than masking it.
                try {
                    await this.sessionCache.restoreSessionArchiveMetadata(access.sessionId, archiveSnapshot)
                } catch {
                    // Swallow restore failures - the resume error is the more important signal.
                }
                return resumeResult
            }

            return {
                type: 'success',
                sessionId: resumeResult.sessionId,
                resumed: true,
                ...(applied.cursorSessionProtocol ? { cursorSessionProtocol: applied.cursorSessionProtocol } : {})
            }
        }

        // Not active and not archived (e.g. brand-new session that has not yet connected,
        // or one that ended without writing archive metadata). Forward to resume so the
        // operator still gets one-click revival.
        const resumeResult = await this.resumeSession(access.sessionId, namespace)
        if (resumeResult.type === 'error') {
            return resumeResult
        }

        return { type: 'success', sessionId: resumeResult.sessionId, resumed: true }
    }

    async handoffSessionToLocal(sessionId: string, namespace: string): Promise<LocalHandoffResult> {
        const access = await this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        if (!access.session.active) {
            return { type: 'success' }
        }

        if (access.session.agentState?.controlledByUser === true) {
            return {
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            }
        }

        try {
            await this.rpcGateway.handoffSessionToLocal(access.sessionId)
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : String(error),
                code: 'handoff_failed'
            }
        }

        const inactive = await this.waitForSessionInactive(access.sessionId)
        if (!inactive) {
            return {
                type: 'error',
                message: 'Timed out waiting for remote session to hand off',
                code: 'handoff_failed'
            }
        }

        return { type: 'success' }
    }

    private async recoverClaudeSessionIdFromMessages(sessionId: string, namespace: string): Promise<string | null> {
        const messages = await this.messageService.getMessages(sessionId, 200)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const found = this.extractClaudeSessionId(messages[i].content)
            if (!found) continue

            await this.persistRecoveredClaudeSessionId(sessionId, namespace, found)
            return found
        }
        return null
    }

    private extractClaudeSessionId(value: unknown): string | null {
        if (!value || typeof value !== 'object') {
            return null
        }

        const obj = value as Record<string, unknown>
        const direct = this.normalizeClaudeSessionId(obj.session_id) ?? this.normalizeClaudeSessionId(obj.sessionId)
        if (direct) {
            return direct
        }

        const content = obj.content
        if (content && typeof content === 'object') {
            const found = this.extractClaudeSessionId(content)
            if (found) return found
        }

        const data = obj.data
        if (data && typeof data === 'object') {
            const found = this.extractClaudeSessionId(data)
            if (found) return found
        }

        return null
    }

    private normalizeClaudeSessionId(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null
        }
        const trimmed = value.trim()
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
            ? trimmed
            : null
    }

    private async persistRecoveredClaudeSessionId(sessionId: string, namespace: string, claudeSessionId: string): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const latest = this.sessionCache.getSessionByNamespace(sessionId, namespace)
                ?? await this.sessionCache.refreshSession(sessionId)
            if (!latest?.metadata) return
            if (latest.metadata.claudeSessionId === claudeSessionId) return

            const result = await this.store.sessions.updateSessionMetadata(
                sessionId,
                { ...latest.metadata, claudeSessionId },
                latest.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            if (result.result === 'success') {
                await this.sessionCache.refreshSession(sessionId)
                return
            }
            if (result.result !== 'version-mismatch') {
                return
            }
        }
    }

    private hasSameAgentSessionIds(
        prev: Session['metadata'] | null,
        next: NonNullable<Session['metadata']>
    ): boolean {
        return (prev?.codexSessionId ?? null) === (next.codexSessionId ?? null)
            && (prev?.claudeSessionId ?? null) === (next.claudeSessionId ?? null)
            && (prev?.geminiSessionId ?? null) === (next.geminiSessionId ?? null)
            && (prev?.opencodeSessionId ?? null) === (next.opencodeSessionId ?? null)
            && (prev?.cursorSessionId ?? null) === (next.cursorSessionId ?? null)
            && (prev?.piSessionId ?? null) === (next.piSessionId ?? null)
            && (prev?.kimiSessionId ?? null) === (next.kimiSessionId ?? null)
    }

    private canRunCursorDedup(session: Session): boolean {
        if (session.metadata?.flavor !== 'cursor') {
            return true
        }
        if (session.metadata?.cursorSessionProtocol !== 'acp') {
            return true
        }
        return this.sessionReadyIds.has(session.id)
    }

    private triggerDedupIfNeeded(sessionId: string): void {
        const session = this.sessionCache.getSession(sessionId)
        if (session?.metadata) {
            if (!this.canRunCursorDedup(session)) {
                return
            }
            void this.sessionCache.deduplicateByAgentSessionId(sessionId).catch(() => {
                // best-effort: web-side safety net hides remaining duplicates
            })
        }
    }

    async waitForSessionActive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = await this.getSession(sessionId)
            if (session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async waitForSessionReady(sessionId: string, timeoutMs: number = 60_000): Promise<'ready' | 'ended' | 'timeout'> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.sessionReadyIds.has(sessionId)) {
                return 'ready'
            }
            const session = await this.getSession(sessionId)
            if (!session?.active) {
                return 'ended'
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return 'timeout'
    }

    async waitForSessionInactive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = await this.getSession(sessionId)
            if (!session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async listMachineDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listMachineDirectory(machineId, path)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async readGeneratedImage(sessionId: string, imageId: string): Promise<RpcGeneratedImageResponse> {
        return await this.rpcGateway.readGeneratedImage(sessionId, imageId)
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(sessionId, path)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<SlashCommandsResponse> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string, flavor?: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId, flavor)
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForSession(sessionId)
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.rpcGateway.listCodexModelsForMachine(machineId)
    }

    async listCursorModelsForSession(sessionId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForSession(sessionId)
    }

    async listCursorModelsForMachine(machineId: string): Promise<RpcListCursorModelsResponse> {
        return await this.rpcGateway.listCursorModelsForMachine(machineId)
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForSession(sessionId)
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.rpcGateway.listOpencodeModelsForCwd(machineId, cwd)
    }

    /** Generic Pi RPC — delegates to rpcGateway.callPiRpc. */
    async callPiRpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        return await this.rpcGateway.callPiRpc<T>(sessionId, method, params, timeoutMs)
    }

    async listOpencodeReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListOpencodeReasoningEffortOptionsResponse> {
        return await this.rpcGateway.listOpencodeReasoningEffortOptionsForSession(sessionId)
    }
}
