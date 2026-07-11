import type { Sql } from '../pgIndex'
import type { StoredMessage } from '../types'
import {
    addMessage,
    copyMessageToSession,
    getMessages,
    getAllMessages,
    getFirstMessages,
    getDeliverableMessagesAfter,
    getMessagesByPosition,
    getUninvokedLocalMessages,
    getMatureScheduledMessages,
    getImmediateQueuedLocalMessages,
    countMessages,
    countFutureScheduledLocalMessages,
    countFutureScheduledBySessionIds,
    minFutureScheduledAtBySessionIds,
    getMaxSeq,
    cancelQueuedMessage,
    lookupQueuedMessage,
    deleteQueuedMessageById,
    markMessagesInvoked,
    mergeSessionMessages,
    type CancelQueuedMessageResult,
    type LookupQueuedMessageResult,
    type CopyStoredMessageInput
} from './messages'

export class MessageStore {
    private readonly sql: Sql

    constructor(sql: Sql) {
        this.sql = sql
    }

    async addMessage(
        sessionId: string,
        content: unknown,
        localId?: string,
        scheduledAt?: number | null
    ): Promise<StoredMessage> {
        return await addMessage(this.sql, sessionId, content, localId, scheduledAt)
    }

    async copyMessageToSession(
        sessionId: string,
        message: CopyStoredMessageInput
    ): Promise<StoredMessage> {
        return await copyMessageToSession(this.sql, sessionId, message)
    }

    async getMessages(sessionId: string, limit: number = 200): Promise<StoredMessage[]> {
        return await getMessages(this.sql, sessionId, limit)
    }

    async getAllMessages(sessionId: string): Promise<StoredMessage[]> {
        return await getAllMessages(this.sql, sessionId)
    }

    async getFirstMessages(sessionId: string, limit: number = 50): Promise<StoredMessage[]> {
        return await getFirstMessages(this.sql, sessionId, limit)
    }

    async getDeliverableMessagesAfter(
        sessionId: string,
        afterSeq: number,
        now: number,
        limit?: number
    ): Promise<StoredMessage[]> {
        return await getDeliverableMessagesAfter(this.sql, sessionId, afterSeq, now, limit)
    }

    async getMessagesByPosition(
        sessionId: string,
        limit: number,
        before?: { at: number; seq: number }
    ): Promise<StoredMessage[]> {
        return await getMessagesByPosition(this.sql, sessionId, limit, before)
    }

    async getUninvokedLocalMessages(sessionId: string): Promise<StoredMessage[]> {
        return await getUninvokedLocalMessages(this.sql, sessionId)
    }

    async getMatureScheduledMessages(beforeTime: number): Promise<StoredMessage[]> {
        return await getMatureScheduledMessages(this.sql, beforeTime)
    }

    async getImmediateQueuedLocalMessages(sessionId: string): Promise<StoredMessage[]> {
        return await getImmediateQueuedLocalMessages(this.sql, sessionId)
    }

    async countMessages(sessionId: string): Promise<number> {
        return await countMessages(this.sql, sessionId)
    }

    async countFutureScheduledLocalMessages(sessionId: string, now: number): Promise<number> {
        return await countFutureScheduledLocalMessages(this.sql, sessionId, now)
    }

    async countFutureScheduledBySessionIds(
        sessionIds: string[],
        now: number
    ): Promise<Map<string, number>> {
        return await countFutureScheduledBySessionIds(this.sql, sessionIds, now)
    }

    async minFutureScheduledAtBySessionIds(
        sessionIds: string[],
        now: number
    ): Promise<Map<string, number>> {
        return await minFutureScheduledAtBySessionIds(this.sql, sessionIds, now)
    }

    async getMaxSeq(sessionId: string): Promise<number> {
        return await getMaxSeq(this.sql, sessionId)
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        return await cancelQueuedMessage(this.sql, sessionId, messageId)
    }

    async lookupQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<LookupQueuedMessageResult> {
        return await lookupQueuedMessage(this.sql, sessionId, messageId)
    }

    async deleteQueuedMessageById(sessionId: string, messageId: string): Promise<void> {
        return await deleteQueuedMessageById(this.sql, sessionId, messageId)
    }

    async markMessagesInvoked(
        sessionId: string,
        localIds: string[],
        invokedAt: number
    ): Promise<void> {
        return await markMessagesInvoked(this.sql, sessionId, localIds, invokedAt)
    }

    async mergeSessionMessages(
        fromSessionId: string,
        toSessionId: string
    ): Promise<{ moved: number; oldMaxSeq: number; newMaxSeq: number }> {
        return await mergeSessionMessages(this.sql, fromSessionId, toSessionId)
    }
}

export type { CancelQueuedMessageResult, LookupQueuedMessageResult, CopyStoredMessageInput }
