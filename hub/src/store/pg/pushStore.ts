import type { Sql } from '../pgIndex'
import type { StoredPushSubscription } from '../types'
import {
    addPushSubscription,
    getPushSubscriptionsByNamespace,
    removePushSubscription
} from './pushSubscriptions'

export class PushStore {
    private readonly sql: Sql

    constructor(sql: Sql) {
        this.sql = sql
    }

    async addPushSubscription(
        namespace: string,
        subscription: { endpoint: string; p256dh: string; auth: string }
    ): Promise<void> {
        await addPushSubscription(this.sql, namespace, subscription)
    }

    async removePushSubscription(namespace: string, endpoint: string): Promise<void> {
        await removePushSubscription(this.sql, namespace, endpoint)
    }

    async getPushSubscriptionsByNamespace(namespace: string): Promise<StoredPushSubscription[]> {
        return await getPushSubscriptionsByNamespace(this.sql, namespace)
    }
}
