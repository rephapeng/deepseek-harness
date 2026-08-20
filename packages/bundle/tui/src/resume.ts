/**
 * Choosing which persisted session this terminal attaches to. Selection and
 * presentation are pure functions of the listed records plus an explicit clock
 * reading, so the same corpus always offers the same numbered list.
 *
 * Only root sessions started in this working directory are offered: a subagent
 * child is not a continuable conversation, and a session from another directory
 * would resume against a workspace its history does not describe.
 * @module @deepseek-ai/dsh-tui/resume
 */

import z from '@deepseek-ai/schemastery'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { TerminalStyle } from './terminal.ts'

/** What the command line asked this terminal to attach to. */
export type ResumeRequest =
  | {
    /** Start a fresh session; what an invocation naming no selection flag gets. */
    readonly kind: 'new'
  }
  | {
    /** Attach to the most recent eligible session without asking. */
    readonly kind: 'latest'
  }
  | {
    /** Attach to the one session named on the command line. */
    readonly kind: 'session'
    /** The session id to attach to, exactly as the command line supplied it. */
    readonly sessionId: string
  }
  | {
    /** Offer the eligible sessions and attach to the one chosen. */
    readonly kind: 'pick'
  }

/**
 * Schemastery validator for {@link ResumeRequest}. The request crosses the
 * cordis.yml config boundary, so the four variants are checked there rather
 * than trusted: a `session` request without an id has no session to attach to.
 */
export const ResumeRequestSchema: z<ResumeRequest> = z.union([
  z.object({ kind: z.const('new').required() }),
  z.object({ kind: z.const('latest').required() }),
  z.object({ kind: z.const('pick').required() }),
  z.object({ kind: z.const('session').required(), sessionId: z.string().required() }),
])

/** One offered session, with the title resolved for display. */
export interface ResumeCandidate {
  /** The session to resume. */
  readonly id: SessionId
  /** When the session was created, in Unix epoch milliseconds. */
  readonly createdAt: number
  /** The session's recorded title, when it has one. */
  readonly title?: string
}

/** Milliseconds in each unit the age column steps through, largest last. */
const AGE_STEPS: readonly { readonly ms: number; readonly suffix: string }[] = [
  { ms: 1000, suffix: 's' },
  { ms: 60_000, suffix: 'm' },
  { ms: 3_600_000, suffix: 'h' },
  { ms: 86_400_000, suffix: 'd' },
]

/**
 * Select the sessions this terminal may offer, newest first.
 * @param headers - every listed session's header.
 * @param cwd - the working directory this invocation runs in.
 * @param limit - how many sessions to keep.
 * @returns the eligible headers, newest first, capped at `limit`.
 */
export function selectResumable(
  headers: readonly SessionHeader[],
  cwd: string,
  limit: number,
): readonly SessionHeader[] {
  return headers
    .filter(header => header.cwd === cwd && header.origin !== 'subagent')
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
}

/**
 * Render one session's age as a fixed-width relative reading.
 * @param createdAt - when the session was created, in epoch milliseconds.
 * @param now - the current epoch milliseconds.
 * @returns the age, such as `4m` or `2d`; `now` for anything under a second.
 */
export function formatAge(createdAt: number, now: number): string {
  const elapsed = Math.max(0, now - createdAt)
  let chosen: { ms: number; suffix: string } | undefined
  for (const step of AGE_STEPS) {
    if (elapsed >= step.ms) chosen = step
  }
  if (chosen === undefined) return 'now'
  return `${Math.floor(elapsed / chosen.ms)}${chosen.suffix}`
}

/**
 * Render the numbered list of sessions to choose from.
 * @param candidates - the offered sessions, newest first.
 * @param now - the current epoch milliseconds, for the age column.
 * @param style - styling helpers for the active stream.
 * @returns the prompt block, newline-terminated.
 */
export function formatPicker(
  candidates: readonly ResumeCandidate[],
  now: number,
  style: TerminalStyle,
): string {
  const rows = candidates.map((candidate, index) => {
    const age = formatAge(candidate.createdAt, now).padStart(4)
    const label = candidate.title ?? candidate.id
    return `  ${String(index + 1).padStart(2)}. ${style.dim(age)}  ${label}`
  })
  return `${style.bold('  Resume which session?')}\n${rows.join('\n')}\n`
}

/**
 * Resolve a typed answer to one offered session.
 * @param line - the submitted answer, or undefined when input ended.
 * @param count - how many sessions were offered.
 * @returns the zero-based index, or undefined when the answer selects none.
 */
export function parseChoice(line: string | undefined, count: number): number | undefined {
  if (line === undefined) return undefined
  const trimmed = line.trim()
  if (!/^[0-9]+$/u.test(trimmed)) return undefined
  const chosen = Number.parseInt(trimmed, 10)
  return chosen >= 1 && chosen <= count ? chosen - 1 : undefined
}
