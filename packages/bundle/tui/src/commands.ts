/**
 * Terminal presentation for the human-command plane. `ctx.commands` owns
 * discovery and dispatch; this module owns only how a command's roster, its
 * outcome, and an unresolved line read on this surface.
 *
 * A command never reaches the model: its result is drawn here and nowhere else,
 * which is why an unknown slash line is reported rather than submitted as a
 * prompt — silently sending `/copmact` to the model would spend a turn on a
 * typo.
 * @module @deepseek-ai/dsh-tui/commands
 */

import type { CommandDescriptor, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TerminalStyle } from './terminal.ts'

/** The built-in name that lists the roster; no plugin owns it. */
export const HELP_COMMAND = 'help'

/** The line that ends the session; it reaches no registry. */
export const EXIT_COMMAND = 'exit'

/**
 * Whether a submitted line is addressed to the command plane.
 * @param text - the trimmed submitted line.
 * @returns true when the line opens with a slash.
 */
export function isCommandLine(text: string): boolean {
  return text.startsWith('/')
}

/**
 * Render the roster this agent can reach, plus the two names this surface owns.
 * @param descriptors - the registry's scoped, name-sorted descriptors.
 * @param style - styling helpers for the active stream.
 * @returns the listing, newline-terminated.
 */
export function formatCommandList(descriptors: readonly CommandDescriptor[], style: TerminalStyle): string {
  const rows = [
    { name: EXIT_COMMAND, description: 'leave the session' },
    { name: HELP_COMMAND, description: 'list the commands this session can run' },
    ...descriptors,
  ].sort((left, right) => left.name.localeCompare(right.name))
  const width = Math.max(...rows.map(row => row.name.length))
  const lines = rows.map(row => `  /${row.name.padEnd(width)}  ${style.dim(row.description)}`)
  return `${lines.join('\n')}\n`
}

/**
 * Render one settled command outcome.
 * @param result - the registry's normalized outcome.
 * @param style - styling helpers for the active stream.
 * @returns the drawn text, or the empty string for a silent success.
 */
export function formatCommandResult(result: CommandResult, style: TerminalStyle): string {
  if (result.kind === 'error') return `${style.accent(`  ${result.text}`)}\n`
  return result.text === undefined || result.text === '' ? '' : `  ${result.text}\n`
}

/**
 * Report a slash line the registry did not resolve.
 * @param line - the complete submitted line.
 * @param style - styling helpers for the active stream.
 * @returns the report, newline-terminated.
 */
export function formatUnknownCommand(line: string, style: TerminalStyle): string {
  return `${style.accent(`  unknown command: ${line}`)}\n${style.dim(`  /${HELP_COMMAND} lists what this session can run.`)}\n`
}
