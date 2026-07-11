import type { Sql } from '../pgIndex'
import type { StoredPushSubscription } from '../types'

type DbPushSubscriptionRow = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    created_at: number
}

function toStoredPushSubscription(row: DbPushSubscriptionRow): StoredPushSubscription {
    return {
        id: row.id,
        namespace: row.namespace,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        createdAt: row.created_at
    }
}

export async function addPushSubscription(
    sql: Sql,
    namespace: string,
    subscription: { endpoint: string; p256dh: string; auth: string }
): Promise<void> {
    const now = Date.now()
    // SQLite's UPSERT clause is already PG-compatible syntax: `excluded` is
    // valid Postgres. id is SERIAL — omitted so the DB assigns it.
    await sql`
        INSERT INTO push_subscriptions (
            namespace, endpoint, p256dh, auth, created_at
        ) VALUES (
            ${namespace}, ${subscription.endpoint}, ${subscription.p256dh}, ${subscription.auth}, ${now}
        )
        ON CONFLICT(namespace, endpoint)
        DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            created_at = excluded.created_at
    `
}

export async function removePushSubscription(
    sql: Sql,
    namespace: string,
    endpoint: string
): Promise<void> {
    await sql`DELETE FROM push_subscriptions WHERE namespace = ${namespace} AND endpoint = ${endpoint}`
}

export async function getPushSubscriptionsByNamespace(
    sql: Sql,
    namespace: string
): Promise<StoredPushSubscription[]> {
    const rows = await sql`SELECT * FROM push_subscriptions WHERE namespace = ${namespace} ORDER BY created_at DESC`
    return (rows as unknown as DbPushSubscriptionRow[]).map(toStoredPushSubscription)
}
