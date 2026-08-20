/** Terminal presentation of the command plane: the roster, one outcome, and an unresolved line. */

import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { createStyle } from '../src/terminal.ts'
import {
  formatCommandList,
  formatCommandResult,
  formatUnknownCommand,
  isCommandLine,
} from '../src/commands.ts'

/** Unstyled rendering, so assertions read the text a reader sees. */
const style = createStyle(false)

describe('isCommandLine', () => {
  it.each([
    ['/compact', true],
    ['/', true],
    ['compact', false],
    [' /compact', false],
    ['', false],
  ])('classifies %s', (line, expected) => {
    expect(isCommandLine(line)).toBe(expected)
  })
})

describe('formatCommandList', () => {
  it('merges the registry roster with the names this surface owns, sorted', () => {
    const registered: CommandDescriptor[] = [
      { name: 'compact', description: 'compact the conversation' },
      { name: 'goal', description: 'set the objective' },
    ]
    expect(formatCommandList(registered, style)).toBe([
      '  /compact  compact the conversation',
      '  /exit     leave the session',
      '  /goal     set the objective',
      '  /help     list the commands this session can run',
      '',
    ].join('\n'))
  })

  it('lists only its own names when no plugin registered any', () => {
    expect(formatCommandList([], style)).toBe([
      '  /exit  leave the session',
      '  /help  list the commands this session can run',
      '',
    ].join('\n'))
  })
})

describe('formatCommandResult', () => {
  it('draws a successful command\'s text', () => {
    expect(formatCommandResult({ kind: 'success', text: 'compacted' }, style)).toBe('  compacted\n')
  })

  it.each([
    [{ kind: 'success' } as const],
    [{ kind: 'success', text: '' } as const],
  ])('draws nothing for a silent success %#', (result) => {
    expect(formatCommandResult(result, style)).toBe('')
  })

  it('draws a failed command\'s text', () => {
    expect(formatCommandResult({ kind: 'error', text: 'no goal is set' }, style)).toBe('  no goal is set\n')
  })
})

describe('formatUnknownCommand', () => {
  it('names the line and points at the roster', () => {
    expect(formatUnknownCommand('/copmact', style))
      .toBe('  unknown command: /copmact\n  /help lists what this session can run.\n')
  })
})
