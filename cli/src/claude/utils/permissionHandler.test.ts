import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '../sdk/prompts';
import type { Session } from '../session';

function createFakeSession() {
    const queueItems: { message: string; mode: unknown }[] = [];
    let permissionMode: string | undefined;

    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn(),
        },
        queue: {
            unshift: vi.fn((message: string, mode: unknown) => {
                queueItems.push({ message, mode });
            }),
        },
        setPermissionMode: vi.fn((mode: string) => {
            permissionMode = mode;
        }),
        getPermissionMode: vi.fn(() => permissionMode),
    } as unknown as Session;

    return { session, queueItems };
}

describe('PermissionHandler — YOLO plan mode', () => {
    it('injects PLAN_FAKE_RESTART and denies exit_plan_mode in bypassPermissions', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        // Simulate Claude emitting an assistant message with exit_plan_mode tool_use
        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-1', name: 'exit_plan_mode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'exit_plan_mode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        // Should deny with PLAN_FAKE_REJECT (so Claude restarts)
        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });

        // Should inject PLAN_FAKE_RESTART into the queue
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
        expect(queueItems[0].mode).toEqual({ permissionMode: 'bypassPermissions' });
    });

    it('injects PLAN_FAKE_RESTART for ExitPlanMode variant', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-2', name: 'ExitPlanMode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'ExitPlanMode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
    });

    it('allows normal tools in bypassPermissions without queue injection', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
        expect(queueItems).toHaveLength(0);
    });

    // Regression: turn-in-progress switch from default to bypassPermissions via
    // SetSessionConfig RPC updates session.setPermissionMode but doesn't go
    // through handler.handleModeChange. The next canCallTool must reflect the
    // new mode. See issue #735.
    it('reflects session permission mode changes between tool calls', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('default');

        // Simulate RPC handler in runClaude updating the session directly,
        // bypassing handler.handleModeChange (as happens on web dropdown change).
        session.setPermissionMode('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-4', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
    });
});

describe('PermissionHandler — plannotator plan review', () => {
    it('routes exit_plan_mode to plannotator and applies its approve decision', async () => {
        const { session, queueItems } = createFakeSession();
        const reviewerCalls: { plan: string; permissionMode?: string }[] = [];
        const reviewer = async (plan: string, permissionMode?: string) => {
            reviewerCalls.push({ plan, permissionMode });
            return { approved: true, mode: 'acceptEdits' };
        };
        const handler = new PermissionHandler(session, reviewer);
        handler.handleModeChange('default');

        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-p1', name: 'exit_plan_mode', input: { plan: 'Ship the feature.' } }] },
        } as any);

        const result = await handler.handleToolCall(
            'exit_plan_mode',
            { plan: 'Ship the feature.' },
            { permissionMode: 'default' } as any,
            { signal: new AbortController().signal }
        );

        expect(reviewerCalls).toEqual([{ plan: 'Ship the feature.', permissionMode: 'default' }]);
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0]).toEqual({ message: PLAN_FAKE_RESTART, mode: { permissionMode: 'acceptEdits' } });
    });

    it('applies a plannotator deny decision as a rejection with the reason', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session, async () => ({ approved: false, reason: 'Tighten error handling.' }));
        handler.handleModeChange('default');
        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-p2', name: 'exit_plan_mode', input: { plan: 'p' } }] },
        } as any);

        const result = await handler.handleToolCall('exit_plan_mode', { plan: 'p' }, { permissionMode: 'default' } as any, { signal: new AbortController().signal });

        expect(result).toEqual({ behavior: 'deny', message: 'Tighten error handling.' });
        expect(queueItems).toHaveLength(0);
    });

    it('falls back to the web UI when plannotator yields no decision', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session, async () => null);
        handler.handleModeChange('default');
        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-p3', name: 'exit_plan_mode', input: { plan: 'p' } }] },
        } as any);

        const ac = new AbortController();
        const promise = handler.handleToolCall('exit_plan_mode', { plan: 'p' }, { permissionMode: 'default' } as any, { signal: ac.signal });
        // The reviewer is async, so the fall-through to handlePermissionRequest
        // happens on the next tick — flush before asserting a request registered.
        await new Promise((r) => setTimeout(r, 0));
        // Falling through to the web UI registers a pending request (plannotator path never does).
        expect(session.client.updateAgentState).toHaveBeenCalled();
        ac.abort();
        await expect(promise).rejects.toThrow('Permission request aborted');
    });
});
