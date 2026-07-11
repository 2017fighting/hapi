import type { Sql } from '../pgIndex'
import type { StoredSession, VersionedUpdateResult } from '../types'
import {
    deleteSession,
    getOrCreateSession,
    getSession,
    getSessionByNamespace,
    getSessions,
    getSessionsByNamespace,
    setSessionEffort,
    setSessionModel,
    setSessionModelReasoningEffort,
    setSessionServiceTier,
    setSessionTeamState,
    setSessionTodos,
    touchSessionUpdatedAt,
    updateSessionAgentState,
    updateSessionMetadata
} from './sessions'

export class SessionStore {
    private readonly sql: Sql

    constructor(sql: Sql) {
        this.sql = sql
    }

    async getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        model?: string,
        effort?: string,
        modelReasoningEffort?: string
    ): Promise<StoredSession> {
        return await getOrCreateSession(this.sql, tag, metadata, agentState, namespace, model, effort, modelReasoningEffort)
    }

    async updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return await updateSessionMetadata(this.sql, id, metadata, expectedVersion, namespace, options)
    }

    async updateSessionAgentState(
        id: string,
        agentState: unknown,
        expectedVersion: number,
        namespace: string
    ): Promise<VersionedUpdateResult<unknown | null>> {
        return await updateSessionAgentState(this.sql, id, agentState, expectedVersion, namespace)
    }

    async setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): Promise<boolean> {
        return await setSessionTodos(this.sql, id, todos, todosUpdatedAt, namespace)
    }

    async setSessionTeamState(id: string, teamState: unknown, updatedAt: number, namespace: string): Promise<boolean> {
        return await setSessionTeamState(this.sql, id, teamState, updatedAt, namespace)
    }

    async setSessionModel(id: string, model: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return await setSessionModel(this.sql, id, model, namespace, options)
    }

    async setSessionModelReasoningEffort(
        id: string,
        modelReasoningEffort: string | null,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): Promise<boolean> {
        return await setSessionModelReasoningEffort(this.sql, id, modelReasoningEffort, namespace, options)
    }

    async setSessionEffort(id: string, effort: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return await setSessionEffort(this.sql, id, effort, namespace, options)
    }

    async setSessionServiceTier(id: string, serviceTier: string | null, namespace: string, options?: { touchUpdatedAt?: boolean }): Promise<boolean> {
        return await setSessionServiceTier(this.sql, id, serviceTier, namespace, options)
    }

    async touchSessionUpdatedAt(id: string, updatedAt: number, namespace: string): Promise<boolean> {
        return await touchSessionUpdatedAt(this.sql, id, updatedAt, namespace)
    }

    async getSession(id: string): Promise<StoredSession | null> {
        return await getSession(this.sql, id)
    }

    async getSessionByNamespace(id: string, namespace: string): Promise<StoredSession | null> {
        return await getSessionByNamespace(this.sql, id, namespace)
    }

    async getSessions(): Promise<StoredSession[]> {
        return await getSessions(this.sql)
    }

    async getSessionsByNamespace(namespace: string): Promise<StoredSession[]> {
        return await getSessionsByNamespace(this.sql, namespace)
    }

    async deleteSession(id: string, namespace: string): Promise<boolean> {
        return await deleteSession(this.sql, id, namespace)
    }
}
