import { describe, expect, it } from 'bun:test'
import { TunnelSendWindow } from './tunnelSendWindow'

describe('TunnelSendWindow', () => {
    it('has room while in-flight stays under the size', () => {
        const w = new TunnelSendWindow(100)
        expect(w.hasRoom(50)).toBe(true)
        expect(w.hasRoom(101)).toBe(false)
    })

    it('tracks in-flight as sent minus acked', () => {
        const w = new TunnelSendWindow(100)
        w.recordSent(40)
        expect(w.inflight).toBe(40)
        w.applyAck(15)
        expect(w.inflight).toBe(25)
    })

    it('resolves waitForRoom immediately when there is space', async () => {
        const w = new TunnelSendWindow(100)
        let resolved = false
        await w.waitForRoom(50).then(() => {
            resolved = true
        })
        expect(resolved).toBe(true)
        w.recordSent(50)
        expect(w.inflight).toBe(50)
    })

    it('parks waitForRoom when the window is full and resumes on ack', async () => {
        const w = new TunnelSendWindow(100)
        w.recordSent(80) // 80 in flight
        expect(w.hasRoom(30)).toBe(false)

        let resolved = false
        const p = w.waitForRoom(30).then(() => {
            resolved = true
        })
        await Promise.resolve()
        expect(resolved).toBe(false)

        w.applyAck(50) // frees 50 → inflight 30 → 30 more now fits
        await p
        expect(resolved).toBe(true)
        w.recordSent(30)
        expect(w.inflight).toBe(60)
    })

    it('ignores non-monotonic acks', () => {
        const w = new TunnelSendWindow(100)
        w.recordSent(50)
        w.applyAck(40)
        expect(w.inflight).toBe(10)
        w.applyAck(10) // stale / smaller — ignored
        expect(w.inflight).toBe(10)
        w.applyAck(40) // equal — ignored
        expect(w.inflight).toBe(10)
    })

    it('bounds in-flight to the window across many sends', async () => {
        const w = new TunnelSendWindow(100)
        const send = async (bytes: number) => {
            await w.waitForRoom(bytes)
            w.recordSent(bytes)
        }
        await send(30)
        await send(30)
        await send(30)
        expect(w.inflight).toBe(90)

        // Fourth send (30) would push inflight to 120 > 100 → must park.
        let fourthDone = false
        const fourth = send(30).then(() => {
            fourthDone = true
        })
        await Promise.resolve()
        expect(fourthDone).toBe(false)

        // Receiver consumes 40 → ack 40 → inflight drops to 50 → 30 more fits (80 ≤ 100).
        w.applyAck(40)
        await fourth
        expect(fourthDone).toBe(true)
        expect(w.inflight).toBe(80)
    })
})
