/**
 * The terminal app's command-line provider: it owns this app's `--help` and
 * publishes {@link TUI_STARTUP_SERVICE} once the command line is accepted. The
 * frontend is an ordinary consumer that injects that service, so `--help`
 * attaches no terminal and creates no Agent.
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the command line can be read. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal frontend. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the frontend row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** The working directory the session is rooted at. */
  cwd: string
}

/**
 * This app's command: no arguments today, and its own help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Talk to the agent in this terminal: streamed replies, Esc to interrupt, approvals answered inline.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Keys:
  Enter                      send the typed message
  Esc                        interrupt the running turn
  Ctrl+C                     interrupt if running, otherwise exit

Commands:
  /exit                      leave the session

Examples:
  dsh --profile tui                          start an interactive session here
`)
}

/**
 * Parse this app's command line and provide its resolved values as an ordinary
 * Cordis service. On `--help` and on a usage error commander exits the process
 * before the action runs, so nothing is provided and the frontend never mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    ctx.provide(TUI_STARTUP_SERVICE, { cwd: process.cwd() } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
