import type { Sql } from '../pgIndex'
import type { StoredUser } from '../types'

type DbUserRow = {
    id: number
    platform: string
    platform_user_id: string
    namespace: string
    created_at: number
}

function toStoredUser(row: DbUserRow): StoredUser {
    return {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        namespace: row.namespace,
        createdAt: row.created_at
    }
}

export async function getUser(
    sql: Sql,
    platform: string,
    platformUserId: string
): Promise<StoredUser | null> {
    const rows = await sql`SELECT * FROM users WHERE platform = ${platform} AND platform_user_id = ${platformUserId} LIMIT 1`
    const row = rows[0] as DbUserRow | undefined
    return row ? toStoredUser(row) : null
}

export async function getUsersByPlatform(
    sql: Sql,
    platform: string
): Promise<StoredUser[]> {
    const rows = await sql`SELECT * FROM users WHERE platform = ${platform} ORDER BY created_at ASC`
    return (rows as unknown as DbUserRow[]).map(toStoredUser)
}

export async function getUsersByPlatformAndNamespace(
    sql: Sql,
    platform: string,
    namespace: string
): Promise<StoredUser[]> {
    const rows = await sql`SELECT * FROM users WHERE platform = ${platform} AND namespace = ${namespace} ORDER BY created_at ASC`
    return (rows as unknown as DbUserRow[]).map(toStoredUser)
}

export async function addUser(
    sql: Sql,
    platform: string,
    platformUserId: string,
    namespace: string
): Promise<StoredUser> {
    const now = Date.now()
    // INSERT OR IGNORE (SQLite) → ON CONFLICT (platform, platform_user_id) DO NOTHING (Postgres).
    // id is SERIAL — omitted from the INSERT so the DB assigns it.
    await sql`
        INSERT INTO users (
            platform, platform_user_id, namespace, created_at
        ) VALUES (
            ${platform}, ${platformUserId}, ${namespace}, ${now}
        )
        ON CONFLICT (platform, platform_user_id) DO NOTHING
    `

    const row = await getUser(sql, platform, platformUserId)
    if (!row) {
        throw new Error('Failed to create user')
    }
    return row
}

export async function removeUser(
    sql: Sql,
    platform: string,
    platformUserId: string
): Promise<boolean> {
    const result = await sql`DELETE FROM users WHERE platform = ${platform} AND platform_user_id = ${platformUserId}`
    return result.count > 0
}
