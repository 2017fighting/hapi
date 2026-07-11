import type { Sql } from '../pgIndex'
import type { StoredUser } from '../types'
import {
    addUser,
    getUser,
    getUsersByPlatform,
    getUsersByPlatformAndNamespace,
    removeUser
} from './users'

export class UserStore {
    private readonly sql: Sql

    constructor(sql: Sql) {
        this.sql = sql
    }

    async getUser(platform: string, platformUserId: string): Promise<StoredUser | null> {
        return await getUser(this.sql, platform, platformUserId)
    }

    async getUsersByPlatform(platform: string): Promise<StoredUser[]> {
        return await getUsersByPlatform(this.sql, platform)
    }

    async getUsersByPlatformAndNamespace(platform: string, namespace: string): Promise<StoredUser[]> {
        return await getUsersByPlatformAndNamespace(this.sql, platform, namespace)
    }

    async addUser(platform: string, platformUserId: string, namespace: string): Promise<StoredUser> {
        return await addUser(this.sql, platform, platformUserId, namespace)
    }

    async removeUser(platform: string, platformUserId: string): Promise<boolean> {
        return await removeUser(this.sql, platform, platformUserId)
    }
}
