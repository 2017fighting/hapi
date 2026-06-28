import { describe, expect, it } from 'bun:test'
import {
    buildPlannotatorSpawnEnv,
    buildPlannotatorSpawnInput,
    launchPlannotatorPlanReview,
    lookupOnPath,
    parsePlannotatorDecision,
    resolvePlannotatorBin,
    spawnPlannotator,
} from './plannotatorLaunch'

describe('resolvePlannotatorBin', () => {
    it('returns the explicit HAPI_PLANNOTATOR_BIN when the file exists', () => {
        const bin = resolvePlannotatorBin({
            env: { HAPI_PLANNOTATOR_BIN: '/usr/local/bin/plannotator' },
            exists: (p) => p === '/usr/local/bin/plannotator',
            which: () => undefined,
        })
        expect(bin).toBe('/usr/local/bin/plannotator')
    })

    it('returns null when the explicit override does not exist on disk', () => {
        const bin = resolvePlannotatorBin({
            env: { HAPI_PLANNOTATOR_BIN: '/opt/missing/plannotator' },
            exists: () => false,
            which: () => '/usr/local/bin/plannotator',
        })
        expect(bin).toBeNull()
    })

    it('falls back to a PATH lookup of plannotator when no override is set', () => {
        const bin = resolvePlannotatorBin({
            env: {},
            exists: () => false,
            which: (name) => (name === 'plannotator' ? '/usr/local/bin/plannotator' : undefined),
        })
        expect(bin).toBe('/usr/local/bin/plannotator')
    })
})

describe('parsePlannotatorDecision', () => {
    it('maps an approve decision with a setMode to approved + the chosen mode', () => {
        const stdout = JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    updatedPermissions: [
                        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
                    ],
                },
            },
        })
        expect(parsePlannotatorDecision(stdout)).toEqual({ approved: true, mode: 'acceptEdits' })
    })

    it('maps a deny decision to approved=false with the message as reason', () => {
        const stdout = JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'deny', message: 'Tighten the error handling first.' },
            },
        })
        expect(parsePlannotatorDecision(stdout)).toEqual({ approved: false, reason: 'Tighten the error handling first.' })
    })

    it('maps an approve without a setMode to approved with no mode', () => {
        const stdout = JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
        expect(parsePlannotatorDecision(stdout)).toEqual({ approved: true })
    })

    it('returns null for stdout that is not a decision JSON', () => {
        expect(parsePlannotatorDecision('plannotator: command not found')).toBeNull()
    })
})

describe('buildPlannotatorSpawnInput', () => {
    it('builds a Claude Code plan-review hook event with the plan on stdin', () => {
        const stdin = buildPlannotatorSpawnInput({ plan: 'Do the thing.', permissionMode: 'acceptEdits' })
        const event = JSON.parse(stdin) as {
            hook_event_name: string
            permission_mode: string
            tool_input: { plan: string }
        }
        expect(event.hook_event_name).toBe('PermissionRequest')
        expect(event.permission_mode).toBe('acceptEdits')
        expect(event.tool_input.plan).toBe('Do the thing.')
    })
})

describe('buildPlannotatorSpawnEnv', () => {
    it('enables hub mode + claude-code origin while preserving the base environment', () => {
        const env = buildPlannotatorSpawnEnv({ PATH: '/usr/bin', HOME: '/users/ryan' })
        expect(env.PATH).toBe('/usr/bin')
        expect(env.HOME).toBe('/users/ryan')
        expect(env.PLANNOTATOR_HUB_MODE).toBe('1')
        expect(env.PLANNOTATOR_ORIGIN).toBe('claude-code')
    })
})

describe('launchPlannotatorPlanReview', () => {
    it('spawns plannotator and returns the parsed approve decision', async () => {
        const approveStdout = JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'plan', destination: 'session' }] },
            },
        })
        let captured: { bin: string; stdin: string; cwd?: string } | undefined
        const decision = await launchPlannotatorPlanReview(
            { bin: '/bin/plannotator', plan: 'Ship it.', permissionMode: 'plan', cwd: '/repo', env: { PATH: '/usr/bin' } },
            async (args) => {
                captured = args
                return { stdout: approveStdout, status: 0 }
            },
        )
        expect(captured?.bin).toBe('/bin/plannotator')
        expect(captured?.cwd).toBe('/repo')
        expect(JSON.parse(captured!.stdin).tool_input.plan).toBe('Ship it.')
        expect(decision).toEqual({ approved: true, mode: 'plan' })
    })

    it('returns null when stdout is not a decision (caller falls back)', async () => {
        const decision = await launchPlannotatorPlanReview(
            { bin: '/bin/plannotator', plan: 'p', env: {} },
            async () => ({ stdout: 'Error: plan too large', status: 1 }),
        )
        expect(decision).toBeNull()
    })
})

describe('spawnPlannotator', () => {
    it('pipes stdin to the child and returns its stdout + exit status', async () => {
        const result = await spawnPlannotator({ bin: '/bin/cat', stdin: 'hello-stdin', env: {} })
        expect(result.stdout).toBe('hello-stdin')
        expect(result.status).toBe(0)
    })
})

describe('lookupOnPath', () => {
    it('returns the first PATH dir that contains the executable', () => {
        const found = lookupOnPath(
            'plannotator',
            { PATH: '/usr/bin:/usr/local/bin' },
            (p) => p === '/usr/local/bin/plannotator',
        )
        expect(found).toBe('/usr/local/bin/plannotator')
    })

    it('returns undefined when the executable is not on PATH', () => {
        expect(lookupOnPath('plannotator', { PATH: '/usr/bin' }, () => false)).toBeUndefined()
    })

    it('returns undefined when PATH is unset', () => {
        expect(lookupOnPath('plannotator', {}, () => true)).toBeUndefined()
    })
})
