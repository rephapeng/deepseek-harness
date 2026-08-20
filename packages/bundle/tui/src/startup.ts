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
import type { ResumeRequest } from './resume.ts'

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
  /** Which session this invocation attaches to. */
  resume: ResumeRequest
}

/** Either the request the flags resolve to, or the usage error they form. */
export type ResumeResolution =
  | { readonly ok: true; readonly request: ResumeRequest }
  | { readonly ok: false; readonly message: string }

/**
 * Resolve the two session-selection flags into one request.
 *
 * `--resume` with no value asks rather than guesses; with a value it names the
 * session outright. `--continue` is the no-questions form of the same intent.
 * Naming both is a contradiction, so it resolves to a usage error rather than
 * to a silently preferred one.
 * @param options - the parsed command-line options.
 * @returns the resolved request, or the usage error to report.
 */
export function resolveResume(options: { resume?: string | boolean; continue?: boolean }): ResumeResolution {
  const wantsResume = options.resume !== undefined && options.resume !== false
  if (wantsResume && options.continue === true) {
    return { ok: false, message: '--resume and --continue both select a session; use one' }
  }
  if (options.continue === true) return { ok: true, request: { kind: 'latest' } }
  if (typeof options.resume === 'string') return { ok: true, request: { kind: 'session', sessionId: options.resume } }
  if (wantsResume) return { ok: true, request: { kind: 'pick' } }
  return { ok: true, request: { kind: 'new' } }
}

/**
 * This app's command: no arguments today, and its own help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Talk to the agent in this terminal: streamed replies, Esc to interrupt, approvals answered inline.')
    .option('-r, --resume [session]', 'resume a session: pick one, or name it outright')
    .option('-c, --continue', 'resume the most recent session in this directory')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Keys:
  Enter                      send the typed message
  Esc                        interrupt the running turn
  Ctrl+C                     interrupt if running, otherwise exit

Commands:
  /help                      list the commands this session can run
  /exit                      leave the session

Examples:
  dsh --profile tui                          start an interactive session here
  dsh --profile tui --continue               reopen the most recent session here
  dsh --profile tui --resume                 choose a session to reopen
  dsh --profile tui --resume <session-id>    reopen one named session
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
  program.action((options: { resume?: string | boolean; continue?: boolean }) => {
    const resolved = resolveResume(options)
    if (!resolved.ok) {
      // Contradictory flags are a usage error, so they leave through
      // commander's own reporting rather than as a loader mount failure.
      program.error(`error: ${resolved.message}`)
    } else {
      ctx.provide(TUI_STARTUP_SERVICE, {
        cwd: process.cwd(),
        resume: resolved.request,
      } satisfies TuiStartupValues)
    }
  })
  parseCmdline(ctx, program)
}
