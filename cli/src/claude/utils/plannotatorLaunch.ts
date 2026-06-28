/**
 * Runner-side launch of plannotator for ExitPlanMode plan review.
 *
 * When hapi's permission handler intercepts `exit_plan_mode` and the plannotator
 * binary is present on the runner, hapi spawns plannotator (default plan-review
 * mode) with `PLANNOTATOR_HUB_MODE=1`, feeds the plan as a Claude Code hook
 * event on stdin, and reads the `PermissionRequest` decision off stdout. See
 * `adr/0001-plannotator-tunnel.md` (Phase 5) and plannotator's
 * `adr/0003-serve-via-hapi-hub-tunnel.md`.
 *
 * The launch *logic* is pure and dependency-injected (an injected
 * `PlannotatorSpawner`) so it is unit-testable without spawning real processes;
 * `spawnPlannotator` is the production Bun-based spawner injected at the wiring
 * layer.
 */

export interface PlannotatorBinDeps {
    /** Environment variables (defaults to `process.env` in production wiring). */
    env: Record<string, string | undefined>
    /** Whether a resolved path exists on disk. */
    exists: (path: string) => boolean
    /** PATH lookup for an executable name (returns the resolved path or undefined). */
    which: (name: string) => string | undefined
}

/**
 * Resolve the plannotator binary path, or null if it is unavailable.
 *
 * An explicit `HAPI_PLANNOTATOR_BIN` override wins when it points at an existing
 * file; otherwise the `plannotator` executable is looked up on PATH. Returns
 * null when neither is available so the caller can fall back to the built-in
 * ExitPlanModeView.
 */
export function resolvePlannotatorBin(deps: PlannotatorBinDeps): string | null {
    const explicit = deps.env.HAPI_PLANNOTATOR_BIN
    if (explicit) {
        return deps.exists(explicit) ? explicit : null
    }
    return deps.which('plannotator') ?? null
}

/**
 * Walk `$PATH` for an executable, returning the first existing `dir/name` or
 * undefined. Pure + dependency-injected (the `exists` check is injected) so it
 * is unit-testable without touching the filesystem. Used as the production
 * `which` for {@link resolvePlannotatorBin}.
 */
export function lookupOnPath(
    name: string,
    env: Record<string, string | undefined>,
    exists: (path: string) => boolean,
): string | undefined {
    const path = env.PATH
    if (!path) {
        return undefined
    }
    for (const dir of path.split(':')) {
        if (!dir) {
            continue
        }
        const candidate = `${dir}/${name}`
        if (exists(candidate)) {
            return candidate
        }
    }
    return undefined
}

/** hapi's view of a plannotator plan-review decision, parsed from its stdout. */
export interface PlannotatorDecision {
    approved: boolean
    /** Permission mode the user chose (e.g. `acceptEdits`), when the approve set one. */
    mode?: string
    /** Deny feedback shown to the agent as the rejection reason. */
    reason?: string
}

/**
 * Parse plannotator's plan-review decision from its stdout.
 *
 * plannotator's default mode emits a Claude Code `PermissionRequest` hook
 * decision: `{"hookSpecificOutput":{"decision":{"behavior":"allow"|"deny",...}}}`.
 * Returns null when stdout is not a recognizable decision so the caller can
 * fall back to the built-in plan UI.
 */
export function parsePlannotatorDecision(stdout: string): PlannotatorDecision | null {
    let parsed: {
        hookSpecificOutput?: { decision?: { behavior?: string; updatedPermissions?: unknown[]; message?: string } }
    }
    try {
        parsed = JSON.parse(stdout.trim())
    } catch {
        return null
    }
    const decision = parsed.hookSpecificOutput?.decision
    if (decision?.behavior === 'allow') {
        const setMode = Array.isArray(decision.updatedPermissions)
            ? decision.updatedPermissions.find((u): u is { type: string; mode: string } =>
                typeof u === 'object' && u !== null && (u as { type?: string }).type === 'setMode')
            : undefined
        return { approved: true, ...(setMode?.mode ? { mode: setMode.mode } : {}) }
    }
    if (decision?.behavior === 'deny') {
        return { approved: false, ...(decision.message ? { reason: decision.message } : {}) }
    }
    return null
}

export interface PlannotatorSpawnInput {
    plan: string
    /** Agent's current permission mode, threaded through to the review UI. */
    permissionMode?: string
}

/**
 * Build the stdin payload for launching plannotator in default plan-review mode:
 * a Claude Code hook event whose `tool_input.plan` carries the plan and whose
 * `permission_mode` is the agent's current mode. plannotator serves the review
 * UI and emits its `PermissionRequest` decision on stdout.
 */
export function buildPlannotatorSpawnInput(input: PlannotatorSpawnInput): string {
    return JSON.stringify({
        hook_event_name: 'PermissionRequest',
        permission_mode: input.permissionMode ?? 'default',
        tool_input: { plan: input.plan },
    })
}

/**
 * Build the child-process environment for launching plannotator under the hub.
 *
 * - `PLANNOTATOR_HUB_MODE=1` makes plannotator self-register via
 *   `hapi tunnel register`, derive its base path from the returned public URL,
 *   and serve under it (see plannotator `packages/server/hub-mode.ts`).
 * - `PLANNOTATOR_ORIGIN=claude-code` guarantees the Claude Code plan-review
 *   output path (the `PermissionRequest` decision on stdout) regardless of
 *   ambient agent env vars.
 *
 * The base environment (PATH, HOME, …) is preserved so plannotator can resolve
 * `bun` and shell out to `hapi`.
 */
export function buildPlannotatorSpawnEnv(
    base: Record<string, string | undefined>,
): Record<string, string | undefined> {
    return { ...base, PLANNOTATOR_HUB_MODE: '1', PLANNOTATOR_ORIGIN: 'claude-code' }
}

export interface PlannotatorSpawnArgs {
    bin: string
    stdin: string
    env: Record<string, string | undefined>
    cwd?: string
}

export interface PlannotatorSpawnResult {
    stdout: string
    /** Process exit status (null if terminated by a signal). */
    status: number | null
}

/**
 * Injected async spawner so the launch logic is unit-testable without spawning a
 * real process. MUST be non-blocking — plannotator blocks on `waitForDecision()`.
 */
export type PlannotatorSpawner = (args: PlannotatorSpawnArgs) => Promise<PlannotatorSpawnResult>

export interface LaunchPlannotatorPlanReviewInput {
    bin: string
    plan: string
    permissionMode?: string
    cwd?: string
    env: Record<string, string | undefined>
}

/**
 * Launch plannotator in hub-mode plan review, await its decision, and parse it.
 *
 * plannotator blocks on `waitForDecision()` for as long as the user reviews the
 * plan, so the injected spawner must not freeze the event loop (use `Bun.spawn`
 * with piped stdio, not `spawnSync`). Returns null when plannotator exits without
 * a recognizable decision so the caller can fall back to the built-in
 * ExitPlanModeView.
 */
export async function launchPlannotatorPlanReview(
    input: LaunchPlannotatorPlanReviewInput,
    spawn: PlannotatorSpawner,
): Promise<PlannotatorDecision | null> {
    const stdin = buildPlannotatorSpawnInput({ plan: input.plan, permissionMode: input.permissionMode })
    const env = buildPlannotatorSpawnEnv(input.env)
    const result = await spawn({ bin: input.bin, stdin, env, cwd: input.cwd })
    return parsePlannotatorDecision(result.stdout)
}

/**
 * Production `PlannotatorSpawner` backed by `Bun.spawn`.
 *
 * Non-blocking: stdio is piped and the child's exit is awaited, so the runner's
 * event loop stays responsive while plannotator blocks on `waitForDecision`
 * (which can be minutes). plannotator's default plan-review mode reads the hook
 * event from stdin and emits its `PermissionRequest` decision on stdout.
 */
export const spawnPlannotator: PlannotatorSpawner = async ({ bin, stdin, env, cwd }) => {
    const proc = Bun.spawn({
        cmd: [bin],
        cwd,
        env: env as Record<string, string>,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    })
    proc.stdin.write(stdin)
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const status = await proc.exited
    return { stdout, status }
}
