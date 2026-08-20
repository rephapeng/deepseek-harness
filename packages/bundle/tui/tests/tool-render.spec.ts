/** Terminal rendering of each tool render intent, and the bounds every result passes through. */

import { describe, expect, it } from 'vitest'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { createStyle } from '../src/terminal.ts'
import { formatCall, formatResult } from '../src/tool-render.ts'
import type { OutputBounds, RenderedResult } from '../src/tool-render.ts'

/** Unstyled rendering, so assertions read the text a reader sees. */
const style = createStyle(false)

/** Roomy enough that only the tests about bounds hit them. */
const WIDE: OutputBounds = { maxLines: 50, maxChars: 5000 }

/**
 * A successful outcome carrying one text block.
 * @param text - the tool's model-facing text.
 * @returns the completed outcome.
 */
const ok = (text: string): RenderedResult => ({ content: [{ type: 'text', text }], isError: false })

describe('formatCall', () => {
  it('names the tool when it declares no intent', () => {
    expect(formatCall(undefined, 'read', style)).toBe('  · read\n')
  })

  it('shows a shell call as its command and working directory', () => {
    const view: ToolCallView = { card: 'terminal', title: 'ls -la', cwd: '/repo' }
    expect(formatCall(view, 'bash', style)).toBe('  · ls -la (in /repo)\n')
  })

  it('omits the working directory a shell call did not declare', () => {
    expect(formatCall({ card: 'terminal', title: 'ls' }, 'bash', style)).toBe('  · ls\n')
  })

  it('lists the files a mutating call touches', () => {
    const view: ToolCallView = {
      card: 'diff',
      title: 'Write',
      diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }, { path: 'b.ts', oldText: 'y', newText: 'z' }],
    }
    expect(formatCall(view, 'write', style)).toBe('  · Write — a.ts, b.ts\n')
  })

  it('shows a mutating call with no declared file as its title alone', () => {
    expect(formatCall({ card: 'diff', title: 'Write', diffs: [] }, 'write', style)).toBe('  · Write\n')
  })

  it('shows a generic call as its title', () => {
    expect(formatCall({ card: 'generic', title: 'Update todo list' }, 'todo_write', style))
      .toBe('  · Update todo list\n')
  })

  it('rejects a card this build does not know', () => {
    expect(() => formatCall({ card: 'rogue' } as unknown as ToolCallView, 'x', style))
      .toThrow('unreachable variant in formatCall')
  })
})

describe('formatResult', () => {
  it('draws nothing for a silent success', () => {
    expect(formatResult(undefined, { content: [], isError: false }, WIDE, style)).toBe('')
  })

  it('still reports a silent failure', () => {
    expect(formatResult(undefined, { content: [], isError: true }, WIDE, style)).toBe('    failed\n')
  })

  it('falls back to the tool\'s own text when it declares no intent', () => {
    expect(formatResult(undefined, ok('done'), WIDE, style)).toBe('    \n    done\n')
  })

  it('ignores content blocks this surface has no cell for', () => {
    const result: RenderedResult = {
      content: [{ type: 'image', data: 'x', mimeType: 'image/png' } as never, { type: 'text', text: 'kept' }],
      isError: false,
    }
    expect(formatResult(undefined, result, WIDE, style)).toContain('kept')
  })

  it('reports a shell exit code and signal, and stays quiet on success', () => {
    const clean: ToolResultView = { card: 'terminal', output: 'hi', exitCode: 0 }
    expect(formatResult(clean, ok(''), WIDE, style)).toBe('    \n    hi\n')
    const failed: ToolResultView = { card: 'terminal', output: 'boom', exitCode: 2, signal: 'SIGTERM' }
    expect(formatResult(failed, ok(''), WIDE, style)).toBe('    exit 2, signal SIGTERM\n    boom\n')
  })

  it('draws a shell result that produced no output', () => {
    expect(formatResult({ card: 'terminal' }, ok(''), WIDE, style)).toBe('    \n')
  })

  it('summarises a change as created or edited line counts', () => {
    const view: ToolResultView = {
      card: 'diff',
      diffs: [
        { path: 'new.ts', oldText: null, newText: 'a\nb\nc' },
        { path: 'old.ts', oldText: 'a\nb', newText: 'a\nb\nc\nd' },
      ],
    }
    expect(formatResult(view, ok(''), WIDE, style))
      .toBe('    changed\n    + new.ts (3 lines)\n    ~ old.ts (2 → 4 lines)\n')
  })

  it('uses the title a change declares', () => {
    const view: ToolResultView = { card: 'diff', title: 'Applied', diffs: [] }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    Applied\n')
  })

  it('places a read within its file', () => {
    const view: ToolResultView = {
      card: 'read',
      path: 'src/a.ts',
      offset: 10,
      lines: [{ number: 11, text: 'x' }, { number: 12, text: 'y' }],
      totalLines: 400,
    }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    src/a.ts (lines 11–12 of 400)\n')
  })

  it('counts grep matches and lists them', () => {
    const view: ToolResultView = {
      card: 'search',
      shape: 'matches',
      files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hit' }] }],
      truncated: false,
      total: 1,
    }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    1 match in 1 file\n    a.ts:3: hit\n')
  })

  it('pluralises and marks a capped match set', () => {
    const view: ToolResultView = {
      card: 'search',
      shape: 'matches',
      files: [
        { path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] },
        { path: 'b.ts', matches: [{ lineNumber: 2, line: 'y' }] },
      ],
      truncated: true,
      total: 9,
    }
    expect(formatResult(view, ok(''), WIDE, style)).toContain('9 matches in 2 files (capped)')
  })

  it('lists found paths', () => {
    const view: ToolResultView = { card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: false, total: 2 }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    2 paths\n    a.ts\n    b.ts\n')
  })

  it('reports a single found path in the singular', () => {
    const view: ToolResultView = { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: true, total: 1 }
    expect(formatResult(view, ok(''), WIDE, style)).toContain('1 path (capped)')
  })

  it('reports a fetched URL and its status', () => {
    const view: ToolResultView = { card: 'web', kind: 'fetch', url: 'https://x.test', statusCode: 404, truncated: false }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    https://x.test (404)\n')
  })

  it('marks a truncated fetch', () => {
    const view: ToolResultView = { card: 'web', kind: 'fetch', url: 'https://x.test', statusCode: 200, truncated: true }
    expect(formatResult(view, ok(''), WIDE, style)).toContain('— truncated')
  })

  it('lists web sources by title, falling back to the URL', () => {
    const view: ToolResultView = {
      card: 'web',
      kind: 'search',
      sources: [{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test' }],
      truncated: false,
    }
    const out = formatResult(view, ok(''), WIDE, style)
    expect(out).toContain('2 sources')
    expect(out).toContain('A')
    expect(out).toContain('https://b.test')
  })

  it('marks a capped source list', () => {
    const view: ToolResultView = {
      card: 'web', kind: 'search', sources: [{ url: 'https://a.test' }], truncated: true,
    }
    expect(formatResult(view, ok(''), WIDE, style)).toContain('1 source (capped)')
  })

  it('draws a generic card with its title and content', () => {
    const view: ToolResultView = { card: 'generic', title: 'Updated', content: [{ type: 'text', text: 'body' }] }
    expect(formatResult(view, ok(''), WIDE, style)).toBe('    Updated\n    body\n')
  })

  it('falls back to the tool\'s own text when a generic card carries no content', () => {
    expect(formatResult({ card: 'generic' }, ok('body'), WIDE, style)).toBe('    \n    body\n')
  })

  it('draws an empty generic card over an empty result', () => {
    expect(formatResult({ card: 'generic', content: [] }, ok('ignored'), WIDE, style)).toBe('    \n')
  })

  it('marks a failed outcome and keeps its label', () => {
    const failed: RenderedResult = { content: [{ type: 'text', text: 'nope' }], isError: true }
    expect(formatResult({ card: 'generic', title: 'Ran' }, failed, WIDE, style))
      .toBe('    failed: Ran\n    nope\n')
  })

  it('rejects a card this build does not know', () => {
    expect(() => formatResult({ card: 'rogue' } as unknown as ToolResultView, ok(''), WIDE, style))
      .toThrow('unreachable variant in formatResult')
  })
})

describe('output bounds', () => {
  it('replaces the lines past the limit with a count', () => {
    const bounds: OutputBounds = { maxLines: 2, maxChars: 5000 }
    const out = formatResult(undefined, ok('a\nb\nc\nd'), bounds, style)
    expect(out).toContain('a\n    b')
    expect(out).not.toContain('c')
    expect(out).toContain('… +2 more lines')
  })

  it('reports a single dropped line in the singular', () => {
    const out = formatResult(undefined, ok('a\nb'), { maxLines: 1, maxChars: 5000 }, style)
    expect(out).toContain('… +1 more line')
  })

  it('truncates past the character limit and says so', () => {
    const out = formatResult(undefined, ok('abcdefghij'), { maxLines: 50, maxChars: 4 }, style)
    expect(out).toContain('abcd')
    expect(out).not.toContain('efgh')
    expect(out).toContain('… truncated')
  })

  it('reports both bounds when both applied', () => {
    const out = formatResult(undefined, ok('abcdef\nghijkl\nmnopqr'), { maxLines: 2, maxChars: 4 }, style)
    expect(out).toContain('… +1 more line, truncated')
  })
})
