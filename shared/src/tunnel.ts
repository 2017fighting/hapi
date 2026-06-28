import { z } from 'zod'

/**
 * Wire contract for the plannotator reverse tunnel multiplexed over the runner's
 * single `/cli` Socket.IO connection. See `adr/0001-plannotator-tunnel.md`.
 *
 * A tunnel carries one bidirectional event `tunnel:frame`, whose payload is a
 * `[meta, buffer?]` tuple: `meta` is JSON (the {@link TunnelFrameMeta}
 * discriminated union below) and `buffer` is an optional native binary chunk
 * (no base64). Each browser HTTP/WS request is one stream keyed by a hub-minted
 * `streamId`. Direction is implied by the sender:
 *   - hub → runner: `open`, `data`, `end`, `close`
 *   - runner → hub: `headers`, `data`, `end`, `close`, `error`
 *
 * Backpressure (`ack { streamId, upto }`) is a Phase 2 addition; Phase 1 streams
 * without a send window.
 */

/** A plannotator tunnel token is an opaque 128-bit hex string minted by the runner. */
export const TUNNEL_TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** Default per-direction send window (256 KiB). Env-overridable on each side. */
export const TUNNEL_DEFAULT_WINDOW_SIZE = 256 * 1024

export const TunnelErrorCodeSchema = z.enum([
    'upstream-unreachable',
    'upstream-timeout',
    'window-violation',
    'token-unknown'
])
export type TunnelErrorCode = z.infer<typeof TunnelErrorCodeSchema>

const streamIdField = z.string().min(1)

export const TunnelFrameMetaSchema = z.discriminatedUnion('type', [
    // hub -> runner
    z.object({
        type: z.literal('open'),
        streamId: streamIdField,
        token: z.string().min(1),
        method: z.string().min(1),
        /** Upstream path including the leading '/', with the `/plannotator/<token>` prefix stripped. */
        path: z.string(),
        /** Raw query string without the leading '?'; may be ''. */
        query: z.string(),
        headers: z.record(z.string(), z.string()),
        /** Whether the browser request has a body (POST/PUT/PATCH) that will follow as `data` frames. */
        hasBody: z.boolean(),
        /**
         * Stream transport. `'http'` (default) → the runner `fetch`es the upstream and streams
         * the response. `'ws'` → the runner opens a local `WebSocket` and bridges frames both
         * directions via `data` (Phase 4 PTY; no `headers` frame, `close` carries code/reason).
         * Absent ≡ `'http'`, so Phases 1–3 frames are unchanged.
         */
        mode: z.enum(['http', 'ws']).optional()
    }),
    z.object({
        type: z.literal('data'),
        streamId: streamIdField
        // binary chunk carried as the frame's 2nd arg (buffer)
    }),
    z.object({
        type: z.literal('end'),
        streamId: streamIdField
    }),
    z.object({
        type: z.literal('close'),
        streamId: streamIdField,
        code: z.number().int().optional(),
        reason: z.string().optional()
    }),
    // runner -> hub
    z.object({
        type: z.literal('headers'),
        streamId: streamIdField,
        status: z.number().int(),
        headers: z.record(z.string(), z.string()),
        /** When true the whole response body is carried inline as the frame's buffer arg. */
        fin: z.boolean().optional()
    }),
    z.object({
        type: z.literal('error'),
        streamId: streamIdField,
        code: TunnelErrorCodeSchema,
        msg: z.string()
    }),
    // either direction — receiver reports consumed bytes so the sender's window advances.
    z.object({
        type: z.literal('ack'),
        streamId: streamIdField,
        /** Highest contiguous byte offset the receiver has consumed. */
        upto: z.number().int().nonnegative()
    })
])
export type TunnelFrameMeta = z.infer<typeof TunnelFrameMetaSchema>

/** Ack for `tunnel:register`; the runner awaits this before advertising the public URL. */
export const TunnelRegisterAckSchema = z.object({
    ok: z.boolean(),
    error: z.string().optional()
})
export type TunnelRegisterAck = z.infer<typeof TunnelRegisterAckSchema>
