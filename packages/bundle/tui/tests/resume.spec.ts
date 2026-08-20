/** Choosing a session to attach to: eligibility, the offered list, and the answer. */

import { describe, expect, it } from 'vitest'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createStyle } from '../src/terminal.ts'
import { formatAge, formatPicker, parseChoice, ResumeRequestSchema, selectResumable } from '../src/resume.ts'
import type { ResumeCandidate } from '../src/resume.ts'

/** Unstyled rendering, so assertions read the text a reader sees. */
const style = createStyle(false)

/** A fixed clock reading, so age columns are deterministic. */
const NOW = 1_800_000_000_000

/**
 * One listed session header.
 * @param id - the session id.
 * @param createdAt - creation time in epoch milliseconds.
 * @param over - header fields this case varies.
 * @returns the header.
 */
function header(
  id: string,
  createdAt: number,
  over: Partial<SessionHeader> = {},
): SessionHeader {
  return { version: 0, id: id as SessionId, createdAt, cwd: '/workspace', ...over }
}

describe('selectResumable', () => {
  it('keeps this directory\'s root sessions, newest first', () => {
    // A session with no recorded directory cannot be matched to this one.
    const rootless: SessionHeader = { version: 0, id: 'rootless' as SessionId, createdAt: NOW }
    const listed = [
      header('older', NOW - 5000),
      header('newest', NOW - 1000),
      header('elsewhere', NOW, { cwd: '/other' }),
      header('child', NOW, { origin: 'subagent' }),
      rootless,
    ]
    expect(selectResumable(listed, '/workspace', 10).map(entry => entry.id)).toEqual(['newest', 'older'])
  })

  it('caps the list at the configured limit', () => {
    const listed = [header('a', 3), header('b', 2), header('c', 1)]
    expect(selectResumable(listed, '/workspace', 2).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('offers nothing when no session belongs to this directory', () => {
    expect(selectResumable([header('x', 1, { cwd: '/other' })], '/workspace', 10)).toEqual([])
  })
})

describe('formatAge', () => {
  it.each([
    [0, 'now'],
    [999, 'now'],
    [1000, '1s'],
    [90_000, '1m'],
    [7_200_000, '2h'],
    [259_200_000, '3d'],
  ])('renders an elapsed %i ms as %s', (elapsed, expected) => {
    expect(formatAge(NOW - elapsed, NOW)).toBe(expected)
  })

  it('treats a session created in the future as current', () => {
    expect(formatAge(NOW + 60_000, NOW)).toBe('now')
  })
})

describe('formatPicker', () => {
  it('numbers each session and names it by title', () => {
    const candidates: ResumeCandidate[] = [
      { id: 'session-a' as SessionId, createdAt: NOW - 60_000, title: 'Fix the parser' },
      { id: 'session-b' as SessionId, createdAt: NOW - 172_800_000 },
    ]
    expect(formatPicker(candidates, NOW, style)).toBe([
      '  Resume which session?',
      '   1.   1m  Fix the parser',
      '   2.   2d  session-b',
      '',
    ].join('\n'))
  })
})

describe('parseChoice', () => {
  it.each([
    ['1', 0],
    ['3', 2],
    [' 2 ', 1],
  ])('accepts %s', (line, expected) => {
    expect(parseChoice(line, 3)).toBe(expected)
  })

  it.each([
    [''],
    ['0'],
    ['4'],
    ['abc'],
    ['1x'],
    ['-1'],
  ])('rejects %s', (line) => {
    expect(parseChoice(line, 3)).toBeUndefined()
  })

  it('treats ended input as no choice', () => {
    expect(parseChoice(undefined, 3)).toBeUndefined()
  })
})

describe('ResumeRequestSchema', () => {
  it.each([
    [{ kind: 'new' } as const],
    [{ kind: 'latest' } as const],
    [{ kind: 'pick' } as const],
    [{ kind: 'session', sessionId: 'session-7' } as const],
  ])('accepts %o', (request) => {
    expect(new ResumeRequestSchema(request)).toEqual(request)
  })

  it.each([
    [{ kind: 'session' }],
    [{ kind: 'nope' }],
    [{}],
  ])('rejects %o', (request) => {
    expect(() => new ResumeRequestSchema(request as never)).toThrow()
  })
})
