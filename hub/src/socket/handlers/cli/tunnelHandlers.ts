import { TUNNEL_TOKEN_PATTERN, TunnelFrameMetaSchema, type TunnelRegisterAck } from '@hapi/protocol'
import type { HubTunnelStreamManager } from '../../tunnelStreamManager'
import type { TokenRegistry } from '../../tokenRegistry'
import type { CliSocketWithData } from '../../socketTypes'

/**
 * Hub-side control handlers for the plannotator reverse tunnel on the `/cli`
 * namespace. The runner emits `tunnel:register` once per minted token to claim
 * ownership; `tokenRegistry` then resolves the owning socket when the
 * `/plannotator/<token>/*` HTTP route opens a stream (Phase 1+). Mirrors the
 * rpc-register / rpc-unregister pattern in {@link registerRpcHandlers}.
 *
 * Frame bridging (`tunnel:frame`) is handled by the stream manager (Phase 1 #5).
 * See adr/0001-plannotator-tunnel.md.
 */
export function registerTunnelHandlers(socket: CliSocketWithData, tokenRegistry: TokenRegistry, streamManager: HubTunnelStreamManager): void {
    socket.on('tunnel:register', (data: { token: string }, cb?: (answer: TunnelRegisterAck) => void) => {
        const token = typeof data?.token === 'string' ? data.token : ''
        if (!TUNNEL_TOKEN_PATTERN.test(token)) {
            cb?.({ ok: false, error: 'invalid-token' })
            return
        }
        tokenRegistry.register(socket, token)
        cb?.({ ok: true })
    })

    socket.on('tunnel:unregister', (data: { token: string }) => {
        const token = typeof data?.token === 'string' ? data.token : ''
        if (!token) {
            return
        }
        tokenRegistry.unregister(socket, token)
    })

    socket.on('tunnel:frame', (meta: unknown, buffer?: Uint8Array) => {
        const parsed = TunnelFrameMetaSchema.safeParse(meta)
        if (!parsed.success) {
            return
        }
        streamManager.handleFrame(socket, parsed.data, buffer)
    })
}
