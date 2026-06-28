import chalk from 'chalk'
import { registerTunnel } from '@/runner/controlClient'
import type { CommandDefinition, CommandContext } from './types'

/**
 * Parse `tunnel register` flags. Throws on a missing/invalid `--port` so the
 * command handler can surface a clean error and exit.
 */
export function parseRegisterArgs(args: string[]): { port: number; mode?: string; label?: string } {
    let port: number | undefined
    let mode: string | undefined
    let label: string | undefined

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]
        if ((arg === '--port' || arg === '-p') && next !== undefined) {
            port = Number.parseInt(next, 10)
            i += 1
        } else if (arg?.startsWith('--port=')) {
            port = Number.parseInt(arg.slice('--port='.length), 10)
        } else if (arg === '--mode' && next !== undefined) {
            mode = next
            i += 1
        } else if (arg?.startsWith('--mode=')) {
            mode = arg.slice('--mode='.length)
        } else if (arg === '--label' && next !== undefined) {
            label = next
            i += 1
        } else if (arg?.startsWith('--label=')) {
            label = arg.slice('--label='.length)
        }
    }

    if (port === undefined || !Number.isFinite(port) || port <= 0) {
        throw new Error('`tunnel register` requires --port <positive integer>')
    }
    return { port, mode, label }
}

/**
 * `hapi tunnel register --port <p> [--mode …] [--label …]` — ask the running
 * runner daemon to expose a local `localhost:<port>` service through the hub at
 * `https://<hub>/plannotator/<token>` and print the public URL to stdout.
 * See adr/0001-plannotator-tunnel.md.
 */
export const tunnelCommand: CommandDefinition = {
    name: 'tunnel',
    requiresRuntimeAssets: false,
    run: async (context: CommandContext) => {
        const action = context.commandArgs[0]
        if (action !== 'register') {
            console.error(chalk.red('Error:'), 'unknown tunnel subcommand. Usage: hapi tunnel register --port <port>')
            process.exit(1)
        }

        try {
            const { port, mode, label } = parseRegisterArgs(context.commandArgs.slice(1))
            const result = await registerTunnel({ port, mode, label })
            if ('error' in result) {
                console.error(chalk.red('Error:'), result.error)
                process.exit(1)
            }
            // Only the public URL goes to stdout so callers (e.g. plannotator) can parse it.
            console.log(result.publicUrl)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
