/**
 * Runner-side map of plannotator tunnel tokens to the local plannotator server
 * port (and metadata). The control server writes here when `hapi tunnel register`
 * runs; the tunnel proxy reads here to route `open` frames to the right
 * localhost port. Tokens live in memory; Phase 6 re-registers live tokens on
 * Socket.IO reconnect. See adr/0001-plannotator-tunnel.md.
 */
export interface RunnerTunnelEntry {
    port: number
    mode?: string
    label?: string
    createdAt: number
}

export class RunnerTunnelRegistry {
    private readonly entries = new Map<string, RunnerTunnelEntry>()

    register(token: string, entry: RunnerTunnelEntry): void {
        this.entries.set(token, entry)
    }

    get(token: string): RunnerTunnelEntry | undefined {
        return this.entries.get(token)
    }

    delete(token: string): boolean {
        return this.entries.delete(token)
    }

    /** Snapshot of all live tokens (Phase 6 reconnect re-registration). */
    list(): ReadonlyArray<readonly [string, RunnerTunnelEntry]> {
        return Array.from(this.entries.entries())
    }
}
