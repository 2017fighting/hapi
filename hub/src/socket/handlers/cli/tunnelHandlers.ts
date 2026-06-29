import { TUNNEL_TOKEN_PATTERN, TunnelFrameMetaSchema, type TunnelRegisterAck } from '@hapi/protocol'
import type { HubTunnelStreamManager } from '../../tunnelStreamManager'
import type { TokenRegistry } from '../../tokenRegistry'
import type { CliSocketWithData } from '../../socketTypes'

/**
 * Plannotator self-started modes that should surface a `plannotator:opened`
 * notification (toast / push / Telegram) when they register. Plan-review is
 * hapi-driven and already entered through the hub permission UI, so it does NOT
 * fire here. Exact mode strings are minted by plannotator (`hapi tunnel register
 * --mode …`); finalized alongside plannotator in Phase 5 #7. See
 * adr/0001-plannotator-tunnel.md.
 */
const NOTIFIABLE_PLANNOTATOR_MODES = new Set(['review', 'annotate'])

/**
 * A notifiable plannotator registration, handed to the hub wiring layer
 * (startHub) which owns `publicUrl` + `notificationHub` and turns this into a
 * {@link PlannotatorOpenedInfo} dispatched to the notification channels.
 */
export type PlannotatorRegisterInfo = {
    namespace: string
    mode?: string
    label?: string
    token: string
}

export type TunnelHandlersOptions = {
    /** Invoked when a self-started plannotator mode (review/annotate) registers. */
    onPlannotatorOpened?: (info: PlannotatorRegisterInfo) => void
}

/**
 * Hub-side control handlers for the plannotator reverse tunnel on the `/cli`
 * namespace. The runner emits `tunnel:register` once per minted token to claim
 * ownership; `tokenRegistry` then resolves the owning socket when the
 * `/plannotator/<token>/*` HTTP route opens a stream (Phase 1+). Mirrors the
 * rpc-register / rpc-unregister pattern in {@link registerRpcHandlers}.
 *
 * Frame bridging (`tunnel:frame`) is handled by the stream manager (Phase 1 #5).
 * For self-started plannotator modes the register handler also surfaces a
 * `plannotator:opened` notification (Phase 5 #6). See adr/0001-plannotator-tunnel.md.
 */
export function registerTunnelHandlers(
    socket: CliSocketWithData,
    tokenRegistry: TokenRegistry,
    streamManager: HubTunnelStreamManager,
    options?: TunnelHandlersOptions
): void {
    socket.on('tunnel:register', (data: { token: string; mode?: string; label?: string }, cb?: (answer: TunnelRegisterAck) => void) => {
        const token = typeof data?.token === 'string' ? data.token : ''
        const mode = typeof data?.mode === 'string' ? data.mode : undefined
        const label = typeof data?.label === 'string' ? data.label : undefined
        if (!TUNNEL_TOKEN_PATTERN.test(token)) {
            cb?.({ ok: false, error: 'invalid-token' })
            return
        }
        tokenRegistry.register(socket, token)
        cb?.({ ok: true })

        if (mode && NOTIFIABLE_PLANNOTATOR_MODES.has(mode)) {
            const namespace = typeof socket.data?.namespace === 'string' ? socket.data.namespace : null
            if (namespace && options?.onPlannotatorOpened) {
                options.onPlannotatorOpened({ namespace, mode, label, token })
            }
        }
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
