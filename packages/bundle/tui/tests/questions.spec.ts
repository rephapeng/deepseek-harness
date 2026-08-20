/** How one user question reads on this surface, and how a typed line becomes its answer. */

import { describe, expect, it } from 'vitest'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { createStyle } from '../src/terminal.ts'
import { formatQuestion, formatQuestionPrompt, parseAnswer } from '../src/questions.ts'

/** Unstyled rendering, so assertions read the text a reader sees. */
const style = createStyle(false)

/** A single-select question with two described options. */
const choice: AskUserQuestionItem = {
  id: 'q1',
  question: 'Which database?',
  header: 'Storage',
  detail: 'Both are already provisioned.',
  options: [
    { label: 'Postgres', description: 'relational' },
    { label: 'Redis' },
  ],
}

describe('formatQuestion', () => {
  it('draws the header, question, detail, and numbered options', () => {
    expect(formatQuestion(choice, style)).toBe([
      '',
      '  [Storage]',
      '  Which database?',
      '  Both are already provisioned.',
      '   1. Postgres — relational',
      '   2. Redis',
      '',
    ].join('\n'))
  })

  it('draws a bare question with neither menu nor supporting text', () => {
    expect(formatQuestion({ id: 'q', question: 'What should I name it?' }, style))
      .toBe('\n  What should I name it?\n')
  })
})

describe('formatQuestionPrompt', () => {
  it('asks for one number when a single choice is offered', () => {
    expect(formatQuestionPrompt(choice, style)).toBe('  number, or type your own › ')
  })

  it('asks for several numbers when the question is multi-select', () => {
    expect(formatQuestionPrompt({ ...choice, multiSelect: true }, style))
      .toBe('  numbers, comma-separated, or type your own › ')
  })

  it('asks for plain text when no options are offered', () => {
    expect(formatQuestionPrompt({ id: 'q', question: 'Name?' }, style)).toBe('  answer › ')
  })
})

describe('parseAnswer', () => {
  it('selects the named option', () => {
    expect(parseAnswer(choice, '2')).toEqual({ id: 'q1', selected: ['Redis'] })
  })

  it('keeps only the first pick for a single-select question', () => {
    expect(parseAnswer(choice, '2,1')).toEqual({ id: 'q1', selected: ['Redis'] })
  })

  it('selects every named option for a multi-select question', () => {
    expect(parseAnswer({ ...choice, multiSelect: true }, '2, 1'))
      .toEqual({ id: 'q1', selected: ['Redis', 'Postgres'] })
  })

  it('collapses a repeated pick', () => {
    expect(parseAnswer({ ...choice, multiSelect: true }, '1,1'))
      .toEqual({ id: 'q1', selected: ['Postgres'] })
  })

  it('keeps free text as the custom answer', () => {
    expect(parseAnswer(choice, 'SQLite, actually'))
      .toEqual({ id: 'q1', selected: [], custom: 'SQLite, actually' })
  })

  it('keeps a plain-text answer when the question offers no options', () => {
    expect(parseAnswer({ id: 'q', question: 'Name?' }, 'widget'))
      .toEqual({ id: 'q', selected: [], custom: 'widget' })
  })

  it.each([
    ['9'],
    ['0'],
    ['7,8'],
  ])('skips a numeric answer naming no offered option (%s)', (line) => {
    expect(parseAnswer(choice, line)).toEqual({ id: 'q1', selected: [] })
  })

  it('keeps the valid picks from a partly out-of-range multi-select answer', () => {
    expect(parseAnswer({ ...choice, multiSelect: true }, '1,9'))
      .toEqual({ id: 'q1', selected: ['Postgres'] })
  })

  it.each([
    [''],
    ['   '],
    [undefined],
  ])('skips the question for an empty answer (%s)', (line) => {
    expect(parseAnswer(choice, line)).toEqual({ id: 'q1', selected: [] })
  })
})
