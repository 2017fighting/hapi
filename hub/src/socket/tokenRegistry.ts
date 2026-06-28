import type { Socket } from 'socket.io'

/**
 * Bidirectional map of plannotator tunnel tokens ↔ the runner socket that owns
 * them. Mirrors {@link RpcRegistry}: a runner registers the opaque tokens it
 * minted for its local plannotator servers, and the hub's
 * `/plannotator/<token>/*` route looks up the owning socket to frame the tunnel
 * over the existing `/cli` Socket.IO connection.
 *
 * On runner-socket disconnect, `unregisterAll` drops every token that socket
 * owned so the hub stops routing to a gone runner (returns 503).
 *
 * See `adr/0001-plannotator-tunnel.md`.
 */
export class TokenRegistry {
    private readonly tokenToSocketId: Map<string, string> = new Map()
    private readonly socketIdToTokens: Map<string, Set<string>> = new Map()

    register(socket: Socket, token: string): void {
        if (!token) {
            return
        }

        this.tokenToSocketId.set(token, socket.id)

        const existing = this.socketIdToTokens.get(socket.id)
        if (existing) {
            existing.add(token)
        } else {
            this.socketIdToTokens.set(socket.id, new Set([token]))
        }
    }

    unregister(socket: Socket, token: string): void {
        const socketId = this.tokenToSocketId.get(token)
        if (socketId === socket.id) {
            this.tokenToSocketId.delete(token)
        }

        const tokens = this.socketIdToTokens.get(socket.id)
        if (tokens) {
            tokens.delete(token)
            if (tokens.size === 0) {
                this.socketIdToTokens.delete(socket.id)
            }
        }
    }

    unregisterAll(socket: Socket): void {
        const tokens = this.socketIdToTokens.get(socket.id)
        if (!tokens) {
            return
        }
        for (const token of tokens) {
            const socketId = this.tokenToSocketId.get(token)
            if (socketId === socket.id) {
                this.tokenToSocketId.delete(token)
            }
        }
        this.socketIdToTokens.delete(socket.id)
    }

    getSocketIdForToken(token: string): string | null {
        return this.tokenToSocketId.get(token) ?? null
    }
}
