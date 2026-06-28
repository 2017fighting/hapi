/**
 * Sliding-window flow control for one direction of a tunnel stream (Phase 2
 * backpressure). The sender records bytes sent and awaits room before emitting
 * more; the receiver reports consumption via {@link applyAck}. In-flight bytes
 * (sent − acked) are bounded to `size`, so a fast-sender / slow-receiver link
 * cannot accumulate unbounded memory. See `adr/0001-plannotator-tunnel.md`.
 *
 * Usage (sender): `await window.waitForRoom(chunk.length); emit(chunk); window.recordSent(chunk.length)`.
 * Usage (receiver): on drain, `otherSide.send({type:'ack', streamId, upto: consumed})`.
 */
export class TunnelSendWindow {
    private sent = 0
    private acked = 0
    private readonly waiters: Array<() => void> = []

    constructor(private readonly size: number) {}

    /** Bytes sent but not yet acked by the receiver. */
    get inflight(): number {
        return this.sent - this.acked
    }

    /** True if `bytes` more can be sent without exceeding the window. */
    hasRoom(bytes: number): boolean {
        return this.inflight + bytes <= this.size
    }

    /**
     * Resolve once `bytes` can be sent. Resolves immediately if there is room;
     * otherwise parks until an ack frees enough (re-checked after each ack).
     */
    async waitForRoom(bytes: number): Promise<void> {
        if (bytes >= this.size) {
            // A single chunk at least as large as the whole window cannot be split
            // and would otherwise wait forever; let it through (it is inherently bounded).
            return
        }
        while (!this.hasRoom(bytes)) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve)
            })
        }
    }

    /** Record that `bytes` were emitted (advances the in-flight count). */
    recordSent(bytes: number): void {
        if (bytes > 0) {
            this.sent += bytes
        }
    }

    /** Apply the receiver's ack: bytes consumed up to `upto`. Wakes parked senders. */
    applyAck(upto: number): void {
        if (upto <= this.acked) {
            return
        }
        this.acked = upto
        // Wake every waiter; each re-checks hasRoom() and re-parks if its chunk still lacks room.
        const pending = this.waiters.splice(0)
        for (const wake of pending) {
            wake()
        }
    }
}
