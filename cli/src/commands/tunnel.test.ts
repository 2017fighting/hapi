import { describe, expect, it } from 'bun:test'
import { parseRegisterArgs } from './tunnel'

describe('parseRegisterArgs', () => {
    it('parses --port <n>', () => {
        expect(parseRegisterArgs(['--port', '1234'])).toEqual({ port: 1234 })
    })

    it('parses -p alias', () => {
        expect(parseRegisterArgs(['-p', '8080'])).toEqual({ port: 8080 })
    })

    it('parses --port=<n> plus --mode and --label', () => {
        expect(parseRegisterArgs(['--port=99', '--mode', 'review', '--label', 'main diff'])).toEqual({
            port: 99,
            mode: 'review',
            label: 'main diff'
        })
    })

    it('throws when --port is missing', () => {
        expect(() => parseRegisterArgs([])).toThrow(/--port/)
    })

    it('throws when --port is not a positive integer', () => {
        expect(() => parseRegisterArgs(['--port', '0'])).toThrow()
        expect(() => parseRegisterArgs(['--port', 'abc'])).toThrow()
        expect(() => parseRegisterArgs(['--port', '-5'])).toThrow()
    })
})
